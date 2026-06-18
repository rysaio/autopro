import { jsonSchema, type ToolSet } from "ai";
import type { SkillManifest, ToolInvocation } from "@secops-agent/shared";
import type { ModelToolCall } from "../providers/types.js";
import { approvalResult, ApprovalStore } from "../runtime/approvalStore.js";
import { skillPacksFor } from "../skills/catalog.js";
import { createActionTools } from "./actionTools.js";
import { isRecoverableToolResult } from "./guidance.js";
import { validateToolInput } from "./inputValidation.js";
import { createSecOpsTools } from "./secopsTools.js";
import type { SecOpsTool, ToolContext, ToolExecutionRecord } from "./types.js";
import { createWazuhTools } from "./wazuhTools.js";

export class ToolRegistry {
  private readonly byApiName = new Map<string, SecOpsTool>();
  private readonly byManifestId = new Map<string, SecOpsTool>();

  constructor(
    tools: SecOpsTool[] = [...createSecOpsTools(), ...createActionTools(), ...createWazuhTools()],
    private readonly approvals = new ApprovalStore()
  ) {
    for (const tool of tools) {
      if (this.byApiName.has(tool.apiName)) {
        throw new Error(`Duplicate tool apiName: ${tool.apiName}`);
      }
      if (this.byManifestId.has(tool.manifest.id)) {
        throw new Error(`Duplicate tool manifest id: ${tool.manifest.id}`);
      }
      this.byApiName.set(tool.apiName, tool);
      this.byManifestId.set(tool.manifest.id, tool);
    }
  }

  manifests(): SkillManifest[] {
    return [...this.byManifestId.values()].map((tool) => tool.manifest);
  }

  skillPacks() {
    return skillPacksFor(this.manifests());
  }

  modelTools(enabledManifestIds?: string[]) {
    const enabled = this.resolveEnabled(enabledManifestIds);
    return enabled.map((tool) => tool.toModelTool());
  }

  aiSdkTools(
    context: ToolContext,
    enabledManifestIds?: string[],
    onRecord?: (record: ToolExecutionRecord) => void
  ): ToolSet {
    const tools: ToolSet = {};
    for (const secOpsTool of this.resolveEnabled(enabledManifestIds)) {
      tools[secOpsTool.apiName] = {
        description: secOpsTool.manifest.description,
        inputSchema: jsonSchema(secOpsTool.manifest.inputSchema),
        // Approval is handled by ToolRegistry so pending calls are persisted and auditable.
        needsApproval: false,
        metadata: {
          manifestId: secOpsTool.manifest.id,
          risk: secOpsTool.manifest.risk,
          toolClass: secOpsTool.manifest.toolClass
        },
        execute: async (input) => {
          const record = await this.executeApiTool(
            secOpsTool.apiName,
            crypto.randomUUID(),
            coerceRecord(input),
            context
          );
          onRecord?.(record);
          return record.invocation.result ?? {
            status: record.invocation.status,
            error: record.invocation.error
          };
        }
      };
    }
    return tools;
  }

  async executeToolCall(call: ModelToolCall, context: ToolContext): Promise<ToolExecutionRecord> {
    return this.executeApiTool(call.function.name, call.id, parseArguments(call.function.arguments), context);
  }

  async executeApiTool(
    apiName: string,
    callId: string,
    parsedArgs: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionRecord> {
    const startedAt = new Date().toISOString();
    const tool = this.byApiName.get(apiName);
    if (!tool) {
      return {
        invocation: {
          id: callId,
          toolName: apiName,
          displayName: apiName,
          status: "failed",
          risk: "high",
          arguments: {},
          error: `Tool ${apiName} is not registered`,
          startedAt,
          completedAt: new Date().toISOString()
        },
        artifacts: []
      };
    }

    const validation = validateToolInput(tool.manifest, parsedArgs);
    if (!validation.ok) {
      return {
        invocation: {
          ...invocation(tool, callId, parsedArgs, "failed", startedAt),
          error: validation.error ?? `Invalid arguments for ${tool.manifest.id}`
        },
        artifacts: []
      };
    }

    const policy = decidePolicy(tool, context, callId);
    if (policy.status !== "executed") {
      const pendingInvocation = invocation(tool, callId, parsedArgs, policy.status, startedAt);
      if (policy.status === "pending_approval") {
        this.approvals.add({
          apiName,
          args: parsedArgs,
          context,
          invocation: pendingInvocation
        });
      }
      return {
        invocation: {
          ...pendingInvocation,
          error: policy.reason
        },
        artifacts: []
      };
    }
    try {
      const result = await tool.execute(parsedArgs, context);
      if (isRecoverableToolResult(result.output)) {
        return {
          invocation: {
            ...invocation(tool, callId, parsedArgs, "failed", startedAt, result.output),
            error: "Recoverable tool guidance returned",
            guidance: result.output.guidance
          },
          artifacts: result.artifacts ?? []
        };
      }
      return {
        invocation: invocation(tool, callId, parsedArgs, "executed", startedAt, result.output),
        artifacts: result.artifacts ?? []
      };
    } catch (error) {
      return {
        invocation: {
          ...invocation(tool, callId, parsedArgs, "failed", startedAt),
          error: error instanceof Error ? error.message : String(error)
        },
        artifacts: []
      };
    }
  }

  async invokeManifest(id: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionRecord> {
    const tool = this.byManifestId.get(id);
    if (!tool) {
      throw new Error(`Tool manifest ${id} is not registered`);
    }
    return this.executeApiTool(tool.apiName, crypto.randomUUID(), args, context);
  }

  pendingApprovals() {
    return this.approvals.list();
  }

  async approveToolCall(id: string, currentPolicy?: Pick<ToolContext, "actionLevel" | "sandboxRoot" | "workspaceRoot">) {
    const pending = this.approvals.take(id);
    if (!pending) {
      return undefined;
    }
    return approvalResult(
      await this.executeApiTool(
        pending.apiName,
        pending.invocation.id,
        pending.args,
        {
          ...pending.context,
          ...currentPolicy,
          permissionMode: "auto",
          approvedToolCallIds: [pending.invocation.id]
        }
      ),
      pending.context.runId
    );
  }

  denyToolCall(id: string) {
    return this.approvals.deny(id);
  }

  private resolveEnabled(enabledManifestIds?: string[]): SecOpsTool[] {
    if (!enabledManifestIds?.length) {
      return [...this.byManifestId.values()];
    }
    return enabledManifestIds
      .map((id) => this.byManifestId.get(id))
      .filter((tool): tool is SecOpsTool => Boolean(tool));
  }
}

function decidePolicy(
  tool: SecOpsTool,
  context: ToolContext,
  callId: string
): { status: "executed" } | { status: "denied" | "pending_approval"; reason: string } {
  if (context.permissionMode === "deny") {
    return tool.manifest.toolClass === "action" && context.actionLevel !== "full-access"
      ? { status: "denied", reason: "Action tool execution denied by permission policy" }
      : { status: "executed" };
  }
  if (tool.manifest.toolClass !== "action") {
    return { status: "executed" };
  }
  if (context.actionLevel === "full-access") {
    return { status: "executed" };
  }
  if (context.actionLevel === "observe") {
    return { status: "denied", reason: "Action tools are disabled at SECOPS_ACTION_LEVEL=observe" };
  }
  if (tool.manifest.id === "full_access.exec") {
    return { status: "denied", reason: "Full access exec requires SECOPS_ACTION_LEVEL=full-access" };
  }
  const approvedReplay = context.approvedToolCallIds?.includes(callId) ?? false;
  if (!approvedReplay && (context.permissionMode === "ask" || tool.manifest.defaultPermission === "ask")) {
    return { status: "pending_approval", reason: "Action tool requires explicit analyst approval" };
  }
  return { status: "executed" };
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function coerceRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function invocation(
  tool: SecOpsTool,
  id: string,
  args: Record<string, unknown>,
  status: ToolInvocation["status"],
  startedAt: string,
  result?: unknown
): ToolInvocation {
  return {
    id,
    toolName: tool.manifest.id,
    displayName: tool.manifest.name,
    status,
    risk: tool.manifest.risk,
    arguments: args,
    result,
    startedAt,
    completedAt: new Date().toISOString()
  };
}
