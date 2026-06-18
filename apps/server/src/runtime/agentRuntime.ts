import type {
  AgentRun,
  AgentRunEvent,
  AgentRunRequest,
  AuditEvent,
  ChatMessage,
  EvidenceArtifact,
  ToolInvocation
} from "@secops-agent/shared";
import { generateText, stepCountIs, type LanguageModel } from "ai";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolExecutionRecord } from "../tools/types.js";
import { SYSTEM_PROMPT } from "./systemPrompt.js";

export interface AgentRuntimeOptions {
  model: LanguageModel;
  registry: ToolRegistry;
  modelName: string;
  providerLabel: string;
  actionLevel: AgentRunContext["actionLevel"];
  sandboxRoot: string;
  workspaceRoot: string;
  maxToolRounds?: number;
}

type AgentRunContext = Parameters<ToolRegistry["aiSdkTools"]>[0];
export type AgentRunEventSink = (event: AgentRunEvent) => void;

export class AgentRuntime {
  constructor(private readonly options: AgentRuntimeOptions) {}

  async run(request: AgentRunRequest, onEvent?: AgentRunEventSink): Promise<AgentRun> {
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const audit: AuditEvent[] = [];
    const toolInvocations: ToolInvocation[] = [];
    const artifacts: EvidenceArtifact[] = [];
    const messages: ChatMessage[] = normalizeMessages(request.messages);
    const maxToolRounds = this.options.maxToolRounds ?? 4;
    let status: AgentRun["status"] = "completed";
    const toolRecords: ToolExecutionRecord[] = [];
    const effectivePermissionMode = this.options.actionLevel === "full-access"
      ? "auto"
      : request.permissionMode ?? "auto";
    const effectiveEnabledTools = this.options.actionLevel === "full-access"
      ? undefined
      : request.enabledTools;
    const context = toolContext({
      runId,
      permissionMode: effectivePermissionMode,
      actionLevel: this.options.actionLevel,
      sandboxRoot: this.options.sandboxRoot,
      workspaceRoot: this.options.workspaceRoot
    });
    const emit = (payload: Omit<AgentRunEvent, "id" | "runId" | "createdAt">) => {
      onEvent?.({
        id: crypto.randomUUID(),
        runId,
        createdAt: new Date().toISOString(),
        ...payload
      });
    };
    emit({ type: "run_started" });

    try {
      const requestAudit = event("model_request", "Model request", `AI SDK run sent to ${this.options.providerLabel}.`);
      audit.push(requestAudit);
      emit({ type: "audit", audit: requestAudit });
      const result = await generateText({
        model: this.options.model,
        system: SYSTEM_PROMPT,
        messages: request.messages
          .filter((message) => message.role === "user" || message.role === "assistant")
          .map((message) => ({
            role: message.role === "assistant" ? "assistant" : "user",
            content: message.content
          })),
        tools: this.options.registry.aiSdkTools(
          context,
          effectiveEnabledTools,
          (record) => {
            toolRecords.push(record);
            toolInvocations.push(record.invocation);
            emit({ type: "tool", invocation: record.invocation });
            artifacts.push(...record.artifacts);
            for (const artifact of record.artifacts) {
              emit({ type: "artifact", artifact });
            }
            const requestedAudit = event("tool_requested", "Tool requested", record.invocation.toolName);
            const policyAudit = event(
              "policy_decision",
              "Policy decision",
              `${record.invocation.displayName} ${record.invocation.status} under ${effectivePermissionMode} mode.`,
              record.invocation.status === "denied" || record.invocation.status === "pending_approval" ? "warn" : "info"
            );
            const resultAudit = event(
              "tool_result",
              "Tool result",
              record.invocation.guidance
                ? `${record.invocation.displayName} returned recoverable guidance: ${record.invocation.guidance.message}`
                : `${record.invocation.displayName} ${record.invocation.status}.`,
              record.invocation.guidance ? "warn" : "info"
            );
            audit.push(requestedAudit, policyAudit, resultAudit);
            emit({ type: "audit", audit: requestedAudit });
            emit({ type: "audit", audit: policyAudit });
            emit({ type: "audit", audit: resultAudit });
            const toolMessage = chat(
              "tool",
              JSON.stringify(record.invocation.result ?? record.invocation.error),
              record.invocation.displayName,
              record.invocation.id
            );
            messages.push(toolMessage);
            emit({ type: "message", message: toolMessage });
          }
        ),
        stopWhen: stepCountIs(maxToolRounds),
        temperature: 0.2
      });

      if (toolRecords.some((record) => record.invocation.status === "pending_approval")) {
        status = "needs_approval";
      }
      const assistantMessage = chat("assistant", result.text || "Agent run completed without final text.");
      messages.push(assistantMessage);
      emit({ type: "message", message: assistantMessage });
      const totalToolResults = result.steps.reduce((count, step) => count + step.toolResults.length, 0);
      const responseAudit = event(
        "model_response",
        "Model response",
        `AI SDK finished with ${result.steps.length} step(s), ${totalToolResults} tool result(s), finish reason ${result.finishReason}.`
      );
      audit.push(responseAudit);
      emit({ type: "audit", audit: responseAudit });
    } catch (error) {
      status = "failed";
      const errorAudit = event("model_response", "Runtime error", error instanceof Error ? error.message : String(error), "error");
      audit.push(errorAudit);
      emit({ type: "audit", audit: errorAudit });
      const errorMessage = chat("assistant", `Agent run failed: ${error instanceof Error ? error.message : String(error)}`);
      messages.push(errorMessage);
      emit({ type: "message", message: errorMessage });
    }

    const run = {
      id: runId,
      status,
      provider: this.options.providerLabel,
      model: this.options.modelName,
      startedAt,
      completedAt: new Date().toISOString(),
      messages,
      toolInvocations,
      audit,
      artifacts
    };
    emit({ type: "run_completed", run });
    return run;
  }
}

function toolContext(context: Omit<AgentRunContext, "approvedToolCallIds">): AgentRunContext {
  return context;
}

function normalizeMessages(messages: AgentRunRequest["messages"]): ChatMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => chat(message.role, message.content));
}

function chat(role: ChatMessage["role"], content: string, name?: string, toolCallId?: string): ChatMessage {
  const message: ChatMessage = {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString()
  };
  if (name) {
    message.name = name;
  }
  if (toolCallId) {
    message.toolCallId = toolCallId;
  }
  return message;
}

function event(
  type: AuditEvent["type"],
  label: string,
  detail: string,
  severity: AuditEvent["severity"] = "info"
): AuditEvent {
  return {
    id: crypto.randomUUID(),
    type,
    label,
    detail,
    severity,
    createdAt: new Date().toISOString()
  };
}
