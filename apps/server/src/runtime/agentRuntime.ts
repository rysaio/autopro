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
import { NoopSessionStateStore, type SessionStateStore, type StateMarker } from "./sessionStateStore.js";
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
  sessionStateStore?: SessionStateStore;
}

type AgentRunContext = Parameters<ToolRegistry["aiSdkTools"]>[0];
export type AgentRunEventSink = (event: AgentRunEvent) => void;

export class AgentRuntime {
  constructor(private readonly options: AgentRuntimeOptions) {}

  async run(request: AgentRunRequest, onEvent?: AgentRunEventSink): Promise<AgentRun> {
    const runId = crypto.randomUUID();
    const sessionId = request.sessionId ?? crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const stateStore = this.options.sessionStateStore ?? new NoopSessionStateStore();
    let persistence = Promise.resolve();
    const persist = (operation: () => Promise<void>) => {
      persistence = persistence.then(operation);
    };
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
    await stateStore.startRun({ sessionId, runId, startedAt });
    for (const message of messages) {
      persist(() => stateStore.appendMessage(sessionId, runId, message));
    }
    const storedMarkers = await stateStore.listStateMarkers(sessionId);
    const context = toolContext({
      runId,
      permissionMode: effectivePermissionMode,
      actionLevel: this.options.actionLevel,
      sandboxRoot: this.options.sandboxRoot,
      workspaceRoot: this.options.workspaceRoot,
      sessionId,
      stateMarkers: storedMarkers.map((marker) => marker.key)
    });
    const emit = (payload: Omit<AgentRunEvent, "id" | "runId" | "createdAt">) => {
      const event = {
        id: crypto.randomUUID(),
        runId,
        createdAt: new Date().toISOString(),
        ...payload
      };
      onEvent?.(event);
      persist(() => stateStore.recordRunEvent(event));
    };
    emit({ type: "run_started" });

    try {
      const requestAudit = event("model_request", "Model request", `AI SDK run sent to ${this.options.providerLabel}.`);
      audit.push(requestAudit);
      persist(() => stateStore.recordAuditEvent(sessionId, runId, requestAudit));
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
            persist(() => stateStore.recordToolInvocation(sessionId, runId, record.invocation, record.artifacts));
            const guidance = record.invocation.guidance;
            if (guidance) {
              persist(() => stateStore.recordGuidance(sessionId, runId, record.invocation.id, guidance));
            }
            const recordMarkers = stateMarkersFromRecord(record);
            if (recordMarkers.length) {
              context.stateMarkers = [...new Set([...(context.stateMarkers ?? []), ...recordMarkers.map((marker) => marker.key)])];
              persist(() => stateStore.recordStateMarkers(sessionId, runId, recordMarkers));
            }
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
            persist(() => stateStore.recordAuditEvent(sessionId, runId, requestedAudit));
            persist(() => stateStore.recordAuditEvent(sessionId, runId, policyAudit));
            persist(() => stateStore.recordAuditEvent(sessionId, runId, resultAudit));
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
            persist(() => stateStore.appendMessage(sessionId, runId, toolMessage));
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
      persist(() => stateStore.appendMessage(sessionId, runId, assistantMessage));
      emit({ type: "message", message: assistantMessage });
      const totalToolResults = result.steps.reduce((count, step) => count + step.toolResults.length, 0);
      const responseAudit = event(
        "model_response",
        "Model response",
        `AI SDK finished with ${result.steps.length} step(s), ${totalToolResults} tool result(s), finish reason ${result.finishReason}.`
      );
      audit.push(responseAudit);
      persist(() => stateStore.recordAuditEvent(sessionId, runId, responseAudit));
      emit({ type: "audit", audit: responseAudit });
    } catch (error) {
      status = "failed";
      const errorAudit = event("model_response", "Runtime error", error instanceof Error ? error.message : String(error), "error");
      audit.push(errorAudit);
      persist(() => stateStore.recordAuditEvent(sessionId, runId, errorAudit));
      emit({ type: "audit", audit: errorAudit });
      const errorMessage = chat("assistant", `Agent run failed: ${error instanceof Error ? error.message : String(error)}`);
      messages.push(errorMessage);
      persist(() => stateStore.appendMessage(sessionId, runId, errorMessage));
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
    persist(() => stateStore.completeRun(sessionId, run));
    emit({ type: "run_completed", run });
    await persistence;
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

function stateMarkersFromRecord(record: ToolExecutionRecord): Array<Omit<StateMarker, "id" | "sessionId" | "runId" | "createdAt">> {
  const markers = stateMarkersFromValue(record.invocation.result);
  return markers.map((key) => ({
    key,
    value: {
      toolCallId: record.invocation.id,
      toolName: record.invocation.toolName
    }
  }));
}

function stateMarkersFromValue(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const markers = (value as { stateMarkers?: unknown }).stateMarkers;
  if (!Array.isArray(markers)) {
    return [];
  }
  return markers.filter((marker): marker is string => typeof marker === "string" && marker.length > 0);
}
