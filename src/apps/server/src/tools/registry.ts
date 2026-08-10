import { jsonSchema, type ToolSet } from "ai";
import type { EvidenceArtifact, SkillManifest, ToolInvocation, ToolInvocationCacheTrace } from "@secops-agent/shared";
import type { ModelToolCall } from "../providers/types.js";
import { approvalResult, ApprovalStore, type PendingApprovalStore } from "../runtime/approvalStore.js";
import { ToolCache, type ToolCacheKeyInput } from "../runtime/toolCache.js";
import { skillPacksFor } from "../skills/catalog.js";
import { createActionTools } from "./actionTools.js";
import { isRecoverableToolResult } from "./guidance.js";
import { validateToolInput } from "./inputValidation.js";
import { createReportTools } from "./reportTools.js";
import { createSecOpsTools } from "./secopsTools.js";
import type { SecOpsTool, ToolContext, ToolExecutionRecord, ToolTimingScopeFactory } from "./types.js";

export class ToolRegistry {
  private readonly byApiName = new Map<string, SecOpsTool>();
  private readonly byManifestId = new Map<string, SecOpsTool>();
  /** 外部（插件）注册的工具，重载插件时整体移除。 */
  private readonly externalApiNames = new Set<string>();
  private readonly externalManifestIds = new Set<string>();
  private readonly deferLoadingOverrides = new Map<string, boolean>();

  constructor(
    tools: SecOpsTool[] = [
      ...createReportTools(),
      ...createSecOpsTools(),
      ...createActionTools()
    ],
    private readonly approvals: PendingApprovalStore = new ApprovalStore(),
    /** auto 模式下 risk=high 的 action 工具是否仍需审批（默认 true，保守）。 */
    private autoApproveHighRisk = true,
    private readonly resultCache: ToolCache = new ToolCache()
  ) {
    for (const tool of tools) {
      this.registerInternal(tool);
    }
  }

  /** 注册外部（插件）工具；与已有工具冲突时抛错且不产生任何残留注册。 */
  registerTools(tools: SecOpsTool[]): void {
    for (const tool of tools) {
      if (this.byApiName.has(tool.apiName)) {
        throw new Error(`Duplicate tool apiName: ${tool.apiName}`);
      }
      if (this.byManifestId.has(tool.manifest.id)) {
        throw new Error(`Duplicate tool manifest id: ${tool.manifest.id}`);
      }
    }
    for (const tool of tools) {
      this.byApiName.set(tool.apiName, tool);
      this.byManifestId.set(tool.manifest.id, tool);
      this.externalApiNames.add(tool.apiName);
      this.externalManifestIds.add(tool.manifest.id);
    }
  }

  /** 移除全部外部（插件）工具，用于插件重载。 */
  unregisterExternalTools(): void {
    for (const apiName of this.externalApiNames) {
      this.byApiName.delete(apiName);
    }
    for (const manifestId of this.externalManifestIds) {
      this.byManifestId.delete(manifestId);
    }
    this.externalApiNames.clear();
    this.externalManifestIds.clear();
  }

  private registerInternal(tool: SecOpsTool): void {
    if (this.byApiName.has(tool.apiName)) {
      throw new Error(`Duplicate tool apiName: ${tool.apiName}`);
    }
    if (this.byManifestId.has(tool.manifest.id)) {
      throw new Error(`Duplicate tool manifest id: ${tool.manifest.id}`);
    }
    this.byApiName.set(tool.apiName, tool);
    this.byManifestId.set(tool.manifest.id, tool);
  }

  /** 设置 auto 模式下 risk=high 的 action 工具是否仍需审批（运行时热更新）。 */
  setAutoApproveHighRisk(value: boolean): void {
    this.autoApproveHighRisk = value;
  }

  cacheStats() {
    return this.resultCache.stats();
  }

  /** Reclaim all cached results recorded under a host namespace (e.g. a plugin). */
  invalidateCacheNamespace(namespace: string): number {
    return this.resultCache.invalidateNamespace(namespace);
  }

  setDeferLoadingOverride(id: string, deferLoading: boolean): boolean {
    if (!this.byManifestId.has(id)) {
      return false;
    }
    this.deferLoadingOverrides.set(id, deferLoading);
    return true;
  }

  clearDeferLoadingOverride(id: string): boolean {
    if (!this.byManifestId.has(id)) {
      return false;
    }
    return this.deferLoadingOverrides.delete(id);
  }

  manifests(): SkillManifest[] {
    return [...this.byManifestId.values()].map((tool) => ({
      ...tool.manifest,
      deferLoading: this.deferLoadingOverrides.get(tool.manifest.id) ?? tool.manifest.deferLoading
    }));
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
    onRecord?: (record: ToolExecutionRecord) => void,
    startTiming?: ToolTimingScopeFactory
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
        execute: async (input, { abortSignal }) => {
          const endTiming = startTiming?.();
          let record: ToolExecutionRecord;
          try {
            const executionContext: ToolContext = { ...context };
            if (abortSignal) {
              executionContext.signal = abortSignal;
            }
            record = await this.executeApiTool(
              secOpsTool.apiName,
              crypto.randomUUID(),
              coerceRecord(input),
              executionContext
            );
          } finally {
            endTiming?.();
          }
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
    context.signal?.throwIfAborted();
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
        artifacts: [],
        metrics: emptyExecutionMetrics()
      };
    }

    const validation = validateToolInput(tool.manifest, parsedArgs);
    if (!validation.ok) {
      return {
        invocation: {
          ...invocation(tool, callId, parsedArgs, "failed", startedAt, undefined, bypass("invalid_arguments")),
          error: validation.error ?? `Invalid arguments for ${tool.manifest.id}`
        },
        artifacts: [],
        metrics: emptyExecutionMetrics()
      };
    }

    const policy = decidePolicy(tool, context, callId, this.autoApproveHighRisk);
    if (policy.status !== "executed") {
      const pendingInvocation = invocation(
        tool,
        callId,
        parsedArgs,
        policy.status,
        startedAt,
        undefined,
        bypass(policy.status)
      );
      if (policy.status === "pending_approval") {
        const { signal: _signal, ...approvalContext } = context;
        await this.approvals.add({
          apiName,
          args: parsedArgs,
          context: approvalContext,
          invocation: pendingInvocation
        });
      }
      return {
        invocation: {
          ...pendingInvocation,
          error: policy.reason
        },
        artifacts: [],
        metrics: emptyExecutionMetrics()
      };
    }

    const cachePolicy = tool.manifest.resultCache;
    const cacheKey = cachePolicy && tool.manifest.toolClass !== "action"
      ? createCacheKey(tool.manifest, parsedArgs, context)
      : undefined;
    let lookupExpiredEntries = 0;
    if (cacheKey && cachePolicy) {
      const cached = this.resultCache.get(cacheKey);
      lookupExpiredEntries = cached.expiredEntries;
      if (cached.status === "hit") {
        const cacheTrace: ToolInvocationCacheTrace = {
          status: "hit",
          sourceInvocationId: cached.value.sourceInvocationId,
          originalCreatedAt: cached.originalCreatedAt,
          ageMs: cached.ageMs,
          avoidedToolDurationMs: cached.value.handlerDurationMs
        };
        return {
          invocation: invocation(
            tool,
            callId,
            parsedArgs,
            "executed",
            startedAt,
            cached.value.result,
            cacheTrace
          ),
          artifacts: freshCachedArtifacts(cached.value.artifacts, cached.ageMs),
          metrics: {
            ...emptyExecutionMetrics(),
            expiredEntries: lookupExpiredEntries,
            avoidedToolDurationMs: cached.value.handlerDurationMs
          }
        };
      }
    }

    const handlerStartedAt = performance.now();
    try {
      context.signal?.throwIfAborted();
      const operation = tool.execute(parsedArgs, context);
      const result = await executeWithSignal(operation, context.signal);
      const handlerDurationMs = roundDuration(performance.now() - handlerStartedAt);
      if (isRecoverableToolResult(result.output)) {
        return {
          invocation: {
            ...invocation(
              tool,
              callId,
              parsedArgs,
              "failed",
              startedAt,
              result.output,
              bypass("recoverable_guidance")
            ),
            error: "Recoverable tool guidance returned",
            guidance: result.output.guidance
          },
          artifacts: result.artifacts ?? [],
          metrics: {
            ...emptyExecutionMetrics(),
            handlerCalled: true,
            handlerDurationMs,
            expiredEntries: lookupExpiredEntries
          }
        };
      }

      const artifacts = result.artifacts ?? [];
      let evictions = 0;
      let expiredEntries = lookupExpiredEntries;
      let invalidatedEntries = 0;
      let cacheTrace = cacheKey && cachePolicy
        ? { status: "miss" as const }
        : bypass(tool.manifest.toolClass === "action" ? "action" : "not_enabled");
      if (cacheKey && cachePolicy) {
        const write = this.resultCache.set(cacheKey, {
          result: result.output,
          artifacts,
          sourceInvocationId: callId,
          handlerDurationMs
        }, cachePolicy.ttlMs);
        evictions = write.evictions;
        expiredEntries += write.expiredEntries;
        if (!write.stored) {
          cacheTrace = bypass("result_not_cloneable");
        }
      }
      if (tool.manifest.toolClass === "action") {
        invalidatedEntries = this.resultCache.invalidateAll();
      }
      return {
        invocation: invocation(tool, callId, parsedArgs, "executed", startedAt, result.output, cacheTrace),
        artifacts,
        metrics: {
          handlerCalled: true,
          handlerDurationMs,
          evictions,
          expiredEntries,
          invalidatedEntries,
          avoidedToolDurationMs: 0
        }
      };
    } catch (error) {
      if (context.signal?.aborted) {
        throw context.signal.reason;
      }
      const handlerDurationMs = roundDuration(performance.now() - handlerStartedAt);
      return {
        invocation: {
          ...invocation(tool, callId, parsedArgs, "failed", startedAt, undefined, bypass("execution_failed")),
          error: error instanceof Error ? error.message : String(error)
        },
        artifacts: [],
        metrics: {
          ...emptyExecutionMetrics(),
          handlerCalled: true,
          handlerDurationMs,
          expiredEntries: lookupExpiredEntries
        }
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

  async pendingApprovals() {
    return this.approvals.list();
  }

  async approveToolCall(id: string, currentPolicy?: Pick<ToolContext, "actionLevel" | "sandboxRoot" | "workspaceRoot">) {
    const pending = await this.approvals.take(id);
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
      pending.context.runId,
      pending.context.sessionId
    );
  }

  async denyToolCall(id: string) {
    return this.approvals.deny(id);
  }

  private resolveEnabled(enabledManifestIds?: string[]): SecOpsTool[] {
    if (enabledManifestIds === undefined) {
      return [...this.byManifestId.values()];
    }
    return enabledManifestIds
      .map((id) => this.byManifestId.get(id))
      .filter((tool): tool is SecOpsTool => Boolean(tool));
  }
}

function executeWithSignal<Result>(operation: Promise<Result>, signal: AbortSignal | undefined): Promise<Result> {
  if (!signal) {
    return operation;
  }
  signal.throwIfAborted();
  return new Promise<Result>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function decidePolicy(
  tool: SecOpsTool,
  context: ToolContext,
  callId: string,
  autoApproveHighRisk: boolean
): { status: "executed" } | { status: "denied" | "pending_approval"; reason: string } {
  // 非 action（读取类）在所有模式下自由调用
  if (tool.manifest.toolClass !== "action") {
    return { status: "executed" };
  }
  // 部署级 actionLevel 闸门
  if (context.actionLevel === "full-access") {
    return { status: "executed" };
  }
  if (context.actionLevel === "observe") {
    return { status: "denied", reason: "Action tools are disabled at SECOPS_ACTION_LEVEL=observe" };
  }
  if (tool.manifest.id === "full_access.exec") {
    return { status: "denied", reason: "Full access exec requires SECOPS_ACTION_LEVEL=full-access" };
  }
  // 全局权限模式（请求级 permissionMode）：deny 为只读，连已批准的重放也拒绝
  if (context.permissionMode === "deny") {
    return { status: "denied", reason: "Action tool execution denied by permission policy" };
  }
  // 审批通过后的重放
  if (context.approvedToolCallIds?.includes(callId) ?? false) {
    return { status: "executed" };
  }
  if (context.permissionMode === "ask") {
    // ask：所有 action 工具均需审批（不再区分工具声明）
    return { status: "pending_approval", reason: "Action tool requires explicit analyst approval" };
  }
  // permissionMode === "auto"：自动执行，可选高危例外
  if (autoApproveHighRisk && tool.manifest.risk === "high") {
    return { status: "pending_approval", reason: "High risk action tool requires approval under auto mode policy" };
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
  result?: unknown,
  cache?: ToolInvocationCacheTrace
): ToolInvocation {
  return {
    id,
    toolName: tool.manifest.id,
    displayName: tool.manifest.name,
    status,
    risk: tool.manifest.risk,
    arguments: args,
    result,
    ...(cache ? { cache } : {}),
    startedAt,
    completedAt: new Date().toISOString()
  };
}

function createCacheKey(
  manifest: SkillManifest,
  args: Record<string, unknown>,
  context: ToolContext
): ToolCacheKeyInput {
  const policy = manifest.resultCache;
  if (!policy) {
    throw new Error(`Cache policy missing for ${manifest.id}`);
  }
  return {
    toolId: manifest.id,
    toolVersion: policy.version,
    dataSource: policy.dataSource,
    workspaceRoot: context.workspaceRoot,
    ...(policy.namespace ? { namespace: policy.namespace } : {}),
    args
  };
}

function freshCachedArtifacts(artifacts: EvidenceArtifact[], ageMs: number): EvidenceArtifact[] {
  return artifacts.map((artifact) => ({
    ...structuredClone(artifact),
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    cacheSource: {
      artifactId: artifact.id,
      originalCreatedAt: artifact.createdAt,
      ageMs
    }
  }));
}

function bypass(reason: string): ToolInvocationCacheTrace {
  return { status: "bypass", reason };
}

function emptyExecutionMetrics(): ToolExecutionRecord["metrics"] {
  return {
    handlerCalled: false,
    handlerDurationMs: 0,
    evictions: 0,
    expiredEntries: 0,
    invalidatedEntries: 0,
    avoidedToolDurationMs: 0
  };
}

function roundDuration(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}
