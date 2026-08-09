import type {
  AgentRun,
  AgentRunEvent,
  AgentRunRequest,
  AuditEvent,
  ChatMessage,
  EvidenceArtifact,
  ToolInvocation
} from "@secops-agent/shared";
import { stepCountIs, streamText, type LanguageModel } from "ai";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolExecutionRecord } from "../tools/types.js";
import { ModelMetricsRecorder } from "./modelMetrics.js";
import { roundDurationMs, RunTimingRecorder } from "./runTimingRecorder.js";
import { NoopSessionStateStore, type SessionStateStore, type StateMarker } from "./sessionStateStore.js";
import { SYSTEM_PROMPT_TRIAGE, SYSTEM_PROMPT_DEEP } from "./systemPrompt.js";
import { systemPromptWithSkills } from "./systemPrompt.js";
import { ToolCache, type ToolCacheCategory } from "./toolCache.js";
import { toolRouter } from "./toolRouter.js";
import type { SkillCatalog } from "../skills/catalog.js";

export interface AgentRuntimeOptions {
  model: LanguageModel;
  registry: ToolRegistry;
  skillCatalog?: Pick<SkillCatalog, "promptSummary">;
  modelName: string;
  providerLabel: string;
  actionLevel: AgentRunContext["actionLevel"];
  sandboxRoot: string;
  workspaceRoot: string;
  maxToolRounds?: number;
  sessionStateStore?: SessionStateStore;
  /** 分诊阶段最大工具轮数（默认 3） */
  maxTriageRounds?: number;
  /** 深度阶段最大工具轮数（默认 8） */
  maxDeepRounds?: number;
  /** 启用分层工具路由（默认 true） */
  enableLayeredRouting?: boolean;
}

type AgentRunContext = Parameters<ToolRegistry["aiSdkTools"]>[0];
export type AgentRunEventSink = (event: AgentRunEvent) => void;

// ── 工具分类到缓存类别的映射 ──
function cacheCategory(toolClass: string): ToolCacheCategory {
  switch (toolClass) {
    case "perception": return "perception";
    case "reasoning": return "reasoning";
    case "evidence": return "evidence";
    case "action": return "action";
    default: return "perception";
  }
}

export class AgentRuntime {
  private readonly toolCache = new ToolCache();

  constructor(private readonly options: AgentRuntimeOptions) {}

  async run(request: AgentRunRequest, onEvent?: AgentRunEventSink): Promise<AgentRun> {
    const runTiming = new RunTimingRecorder();
    const runId = crypto.randomUUID();
    const sessionId = request.sessionId ?? crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const stateStore = this.options.sessionStateStore ?? new NoopSessionStateStore();
    const recordsPersistence = !(stateStore instanceof NoopSessionStateStore);
    let persistence = Promise.resolve();
    let persistenceOperationCount = 0;
    let persistenceDurationMs = 0;
    let persistenceFailureCount = 0;
    let persistenceFailure: unknown;
    const measurePersistenceWait = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
      if (!recordsPersistence) {
        return operation();
      }
      const timing = runTiming.start("persistence");
      try {
        return await operation();
      } finally {
        timing.end();
      }
    };
    const measurePersistenceWrite = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
      if (!recordsPersistence) {
        return operation();
      }
      persistenceOperationCount += 1;
      const timing = runTiming.start("persistence");
      try {
        return await operation();
      } catch (error) {
        persistenceFailureCount += 1;
        throw error;
      } finally {
        persistenceDurationMs += timing.end();
      }
    };
    const persist = (operation: () => Promise<void>) => {
      persistence = persistence.then(async () => {
        try {
          await measurePersistenceWrite(operation);
        } catch (error) {
          persistenceFailure ??= error;
        }
      });
    };
    const audit: AuditEvent[] = [];
    const toolInvocations: ToolInvocation[] = [];
    const artifacts: EvidenceArtifact[] = [];
    const messages: ChatMessage[] = normalizeMessages(request.messages);
    const maxTriageRounds = this.options.maxTriageRounds ?? 3;
    const maxDeepRounds = this.options.maxDeepRounds ?? 8;
    const useLayeredRouting = this.options.enableLayeredRouting !== false;
    const modelMetrics = new ModelMetricsRecorder(runTiming);
    const cacheStatsAtStart = this.toolCache.stats();
    let localRoutingDurationMs = 0;
    const measureRouting = <Result>(operation: () => Result): Result => {
      const startedAt = performance.now();
      try {
        return operation();
      } finally {
        localRoutingDurationMs += performance.now() - startedAt;
      }
    };
    let timeToFirstTextMs: number | undefined;
    let status: AgentRun["status"] = "completed";
    const toolRecords: ToolExecutionRecord[] = [];
    const effectivePermissionMode = this.options.actionLevel === "full-access"
      ? "auto"
      : request.permissionMode ?? "auto";
    const effectiveEnabledTools = this.options.actionLevel === "full-access"
      ? undefined
      : request.enabledTools;
    const skillSummary = this.options.skillCatalog?.promptSummary() ?? "";
    await measurePersistenceWrite(() => stateStore.startRun({ sessionId, runId, startedAt }));
    for (const message of messages) {
      persist(() => stateStore.appendMessage(sessionId, runId, message));
    }
    const storedMarkers = await measurePersistenceWait(() => stateStore.listStateMarkers(sessionId));
    const context = toolContext({
      runId,
      permissionMode: effectivePermissionMode,
      actionLevel: this.options.actionLevel,
      sandboxRoot: this.options.sandboxRoot,
      workspaceRoot: this.options.workspaceRoot,
      sessionId,
      stateMarkers: storedMarkers.map((marker) => marker.key)
    });
    const createRunEvent = (payload: Omit<AgentRunEvent, "id" | "runId" | "createdAt">): AgentRunEvent => {
      return {
        id: crypto.randomUUID(),
        runId,
        createdAt: new Date().toISOString(),
        ...payload
      } as AgentRunEvent;
    };
    const emit = (payload: Omit<AgentRunEvent, "id" | "runId" | "createdAt">) => {
      const runEvent = createRunEvent(payload);
      onEvent?.(runEvent);
      persist(() => stateStore.recordRunEvent(runEvent));
    };
    emit({ type: "run_started" });

    // ── 创建 onRecord 回调工厂 ──
    const createOnRecord = () => (record: ToolExecutionRecord) => {
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

      // ── 缓存写入（创新点） ──
      if (record.invocation.status === "executed" && record.invocation.result) {
        const recordManifest = this.options.registry.manifests().find((m) => m.id === record.invocation.toolName);
        if (recordManifest) {
          this.toolCache.set(
            record.invocation.toolName,
            record.invocation.arguments,
            cacheCategory(recordManifest.toolClass),
            record.invocation.result,
            record.artifacts
          );
          // Action 执行后使缓存失效（状态可能已变更）
          if (recordManifest.toolClass === "action") {
            this.toolCache.invalidateAfterAction();
          }
        }
      }
    };
    const startToolTiming = () => {
      const timing = runTiming.start("tool");
      return () => {
        timing.end();
      };
    };

    try {
      // ── 初始化工具路由器 ──
      measureRouting(() => toolRouter.build(this.options.registry));

      let finalText = "";
      let totalSteps = 0;
      let totalToolResults = 0;

      if (useLayeredRouting) {
        // ══════════════════════════════════════════════════════════════
        // Phase 1: TRIAGE — 仅核心工具（~7个，~1100 tokens）
        // ══════════════════════════════════════════════════════════════
        const triageCategory = measureRouting(() => toolRouter.getCategorySummary()["core-triage"]);
        const triageAudit = event(
          "model_request",
          "Phase 1: Triage",
          `Layered routing: sending core triage tools (${triageCategory?.count ?? 0} tools, ~${triageCategory?.tokens ?? 0} tokens)`
        );
        audit.push(triageAudit);
        persist(() => stateStore.recordAuditEvent(sessionId, runId, triageAudit));
        emit({ type: "audit", audit: triageAudit });

        // 使用 registry 直接生成 triage 工具集，带上 onRecord 以追踪结果
        const triageOnRecord = createOnRecord();
        const triageToolIds = measureRouting(() => toolRouter.getTriageToolIds());
        const triageTools = measureRouting(() => this.options.registry.aiSdkTools(
          context,
          triageToolIds,
          triageOnRecord,
          startToolTiming
        ));
        const triageGeneration = streamText({
          model: modelMetrics.wrap(this.options.model, "triage", triageToolIds.length),
          system: systemPromptWithSkills(SYSTEM_PROMPT_TRIAGE, skillSummary),
          messages: request.messages
            .filter((message) => message.role === "user" || message.role === "assistant")
            .map((message) => ({
              role: message.role === "assistant" ? "assistant" as const : "user" as const,
              content: message.content
            })),
          tools: triageTools,
          stopWhen: stepCountIs(maxTriageRounds),
          temperature: 0.2
        });
        const triageResult = await consumeTextGeneration(triageGeneration);

        totalSteps += triageResult.steps.length;
        totalToolResults += triageResult.steps.reduce((c, s) => c + s.toolResults.length, 0);

        // 收集 Phase 1 中调用的工具名，推断需要加载的专用工具类别
        const triageToolCalls: string[] = [];
        for (const step of triageResult.steps) {
          for (const tc of step.toolCalls) {
            triageToolCalls.push(tc.toolName);
          }
        }
        const userMessage = request.messages
          .filter((m) => m.role === "user")
          .map((m) => m.content)
          .join(" ");
        const inferredCategories = measureRouting(() => toolRouter.inferCategories(triageToolCalls, userMessage));
        const savedTokens = measureRouting(() => toolRouter.estimateTokenSavings(inferredCategories));
        const categorySummary = measureRouting(() => toolRouter.getCategorySummary());
        const specializedToolCount = measureRouting(() => inferredCategories
          .filter((category) => category !== "core-triage")
          .reduce((sum, category) => sum + (categorySummary[category]?.count ?? 0), 0));

        const routeAudit = event(
          "model_request",
          "Phase 2: Deep Dive",
          `Routing: inferred categories [${inferredCategories.join(", ")}], estimated token savings: ~${savedTokens} tokens (${categorySummary["core-triage"]?.count ?? 0} core + ${specializedToolCount} specialized tools)`
        );
        audit.push(routeAudit);
        persist(() => stateStore.recordAuditEvent(sessionId, runId, routeAudit));
        emit({ type: "audit", audit: routeAudit });

        // ══════════════════════════════════════════════════════════════
        // Phase 2: DEEP DIVE — 核心 + 推断的专用工具
        // ══════════════════════════════════════════════════════════════
        const deepOnRecord = createOnRecord();
        // 动作工具（sandbox-actions）固定加载：保证 action 工具永远可达，
        // 不依赖关键词推断（“拉黑/记笔记”等说法可能不在推断表内）
        const deepCategories = new Set(inferredCategories);
        deepCategories.add("sandbox-actions");
        const deepToolIds = measureRouting(() => toolRouter.getDeepToolIds([...deepCategories]));
        const deepTools = measureRouting(() => this.options.registry.aiSdkTools(
          context,
          deepToolIds,
          deepOnRecord,
          startToolTiming
        ));

        // 使用 Phase 1 的完整消息历史作为 Phase 2 的输入
        const phase1Messages = triageResult.response.messages;

        const deepGeneration = streamText({
          model: modelMetrics.wrap(this.options.model, "deep", deepToolIds.length),
          system: systemPromptWithSkills(SYSTEM_PROMPT_DEEP, skillSummary),
          messages: phase1Messages,
          tools: deepTools,
          stopWhen: stepCountIs(maxDeepRounds),
          temperature: 0.2
        });
        const deepResult = await consumeTextGeneration(deepGeneration, () => {
          timeToFirstTextMs ??= runTiming.elapsedMs();
        });

        totalSteps += deepResult.steps.length;
        totalToolResults += deepResult.steps.reduce((c, s) => c + s.toolResults.length, 0);
        finalText = deepResult.text || deepResult.steps.findLast((s) => s.text)?.text || '';
        const deepFinish = deepResult.finishReason === 'tool-calls'
          ? ' [Agent stopped at max tool rounds - increase maxDeepRounds]'
          : '';

        // ── 检查是否有待审批 ──
        if (toolRecords.some((record) => record.invocation.status === "pending_approval")) {
          status = "needs_approval";
        }

        const finalMessage = chat(
          'assistant',
          finalText || 'Agent completed but did not produce a final text summary. Check the tool results above.' + deepFinish
        );
        messages.push(finalMessage);
        persist(() => stateStore.appendMessage(sessionId, runId, finalMessage));
        emit({ type: "message", message: finalMessage });

        const responseAudit = event(
          "model_response",
          "Model response",
          `Layered routing complete: Phase 1 (${triageResult.steps.length} steps, ${triageResult.steps.reduce((c, s) => c + s.toolResults.length, 0)} tool results) + Phase 2 (${deepResult.steps.length} steps, ${deepResult.steps.reduce((c, s) => c + s.toolResults.length, 0)} tool results). Total: ${totalSteps} steps, ${totalToolResults} tool results. Cache: ${Math.round(this.toolCache.hitRate() * 100)}% hit rate, ~${this.toolCache.stats().savedTokensEstimate} tokens saved. Finish: ${deepResult.finishReason}.${deepResult.finishReason === "tool-calls" ? " Max tool rounds reached." : ""}`
        );
        audit.push(responseAudit);
        persist(() => stateStore.recordAuditEvent(sessionId, runId, responseAudit));
        emit({ type: "audit", audit: responseAudit });
      } else {
        // ══════════════════════════════════════════════════════════════
        // 传统模式：全部工具一次性发送（向后兼容）
        // ══════════════════════════════════════════════════════════════
        const requestAudit = event("model_request", "Model request", `AI SDK run sent to ${this.options.providerLabel}.`);
        audit.push(requestAudit);
        persist(() => stateStore.recordAuditEvent(sessionId, runId, requestAudit));
        emit({ type: "audit", audit: requestAudit });

        const singleTools = measureRouting(() => this.options.registry.aiSdkTools(
          context,
          effectiveEnabledTools,
          createOnRecord(),
          startToolTiming
        ));
        const generation = streamText({
          model: modelMetrics.wrap(
            this.options.model,
            "single",
            Object.keys(singleTools).length
          ),
          system: systemPromptWithSkills(SYSTEM_PROMPT_DEEP, skillSummary),
          messages: request.messages
            .filter((message) => message.role === "user" || message.role === "assistant")
            .map((message) => ({
              role: message.role === "assistant" ? "assistant" as const : "user" as const,
              content: message.content
            })),
          tools: singleTools,
          stopWhen: stepCountIs(this.options.maxToolRounds ?? 10),
          temperature: 0.2
        });
        const result = await consumeTextGeneration(generation, () => {
          timeToFirstTextMs ??= runTiming.elapsedMs();
        });

        if (toolRecords.some((record) => record.invocation.status === "pending_approval")) {
          status = "needs_approval";
        }
        finalText = result.text || result.steps.findLast((s) => s.text)?.text || '';
        const finishInfo = result.finishReason === 'tool-calls' ? ' [Agent stopped at max tool rounds - increase maxToolRounds]' : '';
        const assistantMessage = chat('assistant', finalText || 'Agent completed but did not produce a final text summary. Check the tool results above.' + finishInfo);
        messages.push(assistantMessage);
        persist(() => stateStore.appendMessage(sessionId, runId, assistantMessage));
        emit({ type: "message", message: assistantMessage });
        totalToolResults = result.steps.reduce((count, step) => count + step.toolResults.length, 0);
        const responseAudit = event(
          "model_response",
          "Model response",
          `AI SDK finished with ${result.steps.length} step(s), ${totalToolResults} tool result(s), finish reason ${result.finishReason}.${result.finishReason === "tool-calls" ? " Max tool rounds reached before final response." : ""}`
        );
        audit.push(responseAudit);
        persist(() => stateStore.recordAuditEvent(sessionId, runId, responseAudit));
        emit({ type: "audit", audit: responseAudit });
      }
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

    // Flush all queued state writes before taking the run-level snapshot.
    await persistence;
    if (persistenceFailure !== undefined) {
      status = "failed";
      audit.push(event(
        "model_response",
        "Persistence error",
        persistenceFailure instanceof Error ? persistenceFailure.message : String(persistenceFailure),
        "error"
      ));
    }

    // ── 缓存统计 ──
    const cacheStats = this.toolCache.stats();
    const cacheHits = counterDelta(cacheStats.hits, cacheStatsAtStart.hits);
    const cacheMisses = counterDelta(cacheStats.misses, cacheStatsAtStart.misses);
    if (cacheHits > 0) {
      const cacheLookups = cacheHits + cacheMisses;
      const hitRate = cacheLookups === 0 ? 0 : cacheHits / cacheLookups;
      console.log(`[ToolCache] Run ${runId}: ${cacheHits} hits, ${cacheMisses} misses, hit rate ${Math.round(hitRate * 100)}%, ~${counterDelta(cacheStats.savedTokensEstimate, cacheStatsAtStart.savedTokensEstimate)} tokens saved`);
    }

    const run: AgentRun = {
      id: runId,
      sessionId,
      status,
      provider: this.options.providerLabel,
      model: this.options.modelName,
      startedAt,
      completedAt: new Date().toISOString(),
      messages,
      toolInvocations,
      audit,
      artifacts,
      metrics: {
        schemaVersion: 1,
        measurementBoundary: "before-completion-export",
        mode: useLayeredRouting ? "layered" : "single",
        totalDurationMs: 0,
        localOrchestrationDurationMs: 0,
        localRoutingDurationMs: roundDurationMs(localRoutingDurationMs),
        text: timeToFirstTextMs === undefined
          ? { measurement: "unavailable" }
          : { timeToFirstTextMs, measurement: "provider-stream" },
        model: modelMetrics.snapshot(),
        tools: {
          callCount: toolRecords.length,
          totalDurationMs: runTiming.totalDurationMs("tool")
        },
        cache: {
          hits: cacheHits,
          misses: cacheMisses,
          bypasses: toolRecords.length,
          size: cacheStats.size
        },
        persistence: {
          operationCount: persistenceOperationCount,
          totalDurationMs: roundDurationMs(persistenceDurationMs),
          failureCount: persistenceFailureCount
        }
      }
    };
    const completionEvent = createRunEvent({ type: "run_completed", run });
    Object.assign(run.metrics, runTiming.snapshot());
    // The completion export is intentionally outside the metrics snapshot boundary.
    await measurePersistenceWait(() => stateStore.commitRunCompletion(sessionId, run, completionEvent));
    onEvent?.(completionEvent);
    return run;
  }
}

async function consumeTextGeneration(
  generation: ReturnType<typeof streamText>,
  onFirstText?: () => void
) {
  let firstTextSeen = false;
  for await (const part of generation.fullStream) {
    if (!firstTextSeen && part.type === "text-delta" && part.text.length > 0) {
      firstTextSeen = true;
      onFirstText?.();
    }
  }
  const [text, steps, response, finishReason] = await Promise.all([
    generation.text,
    generation.steps,
    generation.response,
    generation.finishReason
  ]);
  return { text, steps, response, finishReason };
}

function counterDelta(current: number, initial: number): number {
  return Math.max(0, current - initial);
}

function toolContext(context: Omit<AgentRunContext, "approvedToolCallIds">): AgentRunContext {
  return context;
}

function normalizeMessages(messages: AgentRunRequest["messages"]): ChatMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => {
      // 保留原始 id/createdAt：每次 run 前端都会传入完整历史，
      // 若重新生成 id，历史消息会以新 id 反复写入会话存储，
      // 导致打开旧对话时同一条消息重复出现（数据库逐 run 膨胀）。
      const normalized: ChatMessage = {
        id: message.id ?? crypto.randomUUID(),
        role: message.role,
        content: message.content,
        createdAt: message.createdAt ?? new Date().toISOString()
      };
      if (message.name) {
        normalized.name = message.name;
      }
      if (message.toolCallId) {
        normalized.toolCallId = message.toolCallId;
      }
      return normalized;
    });
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
