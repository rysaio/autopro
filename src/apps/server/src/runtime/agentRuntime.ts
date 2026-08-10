import type {
  AgentRun,
  AgentRunEvent,
  AgentRunEventPayload,
  AgentRunRequest,
  AgentRoutingDecision,
  AgentRoutingMode,
  AuditEvent,
  ChatMessage,
  EvidenceArtifact,
  ToolInvocation
} from "@secops-agent/shared";
import { stepCountIs, streamText, type LanguageModel } from "ai";
import { ToolRegistry } from "../tools/registry.js";
import type { ToolExecutionRecord } from "../tools/types.js";
import {
  DEFAULT_CONTEXT_BUDGET,
  prepareConversationContext,
  type ContextBudgetConfig,
  type ContextBudgetRequestReport
} from "./contextBudget.js";
import { ModelMetricsRecorder } from "./modelMetrics.js";
import { roundDurationMs, RunTimingRecorder } from "./runTimingRecorder.js";
import { NoopSessionStateStore, type SessionStateStore, type StateMarker } from "./sessionStateStore.js";
import { SYSTEM_PROMPT_TRIAGE, SYSTEM_PROMPT_DEEP, SYSTEM_PROMPT_FINAL } from "./systemPrompt.js";
import { toolRouter } from "./toolRouter.js";

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
  /** 分诊阶段最大工具轮数（默认 3） */
  maxTriageRounds?: number;
  /** 深度阶段最大工具轮数（默认 8） */
  maxDeepRounds?: number;
  /** @deprecated true selects the temporary layered rollback mode. */
  enableLayeredRouting?: boolean;
  /** 默认 deterministic；layered 仅作为临时回滚模式。 */
  agentRoutingMode?: AgentRoutingMode;
  /** 整个运行（模型、工具循环）的硬超时。 */
  runTimeoutMs?: number;
  /** 长对话上下文预算（默认 64k 输入 + 4k 预留输出，保留最近 10 条原文）。 */
  contextBudget?: ContextBudgetConfig;
}

export interface AgentRunExecutionOptions {
  signal?: AbortSignal;
}

export interface AgentRunAbortReason {
  status: "cancelled" | "timed_out";
  message: string;
}

type AgentRunContext = Parameters<ToolRegistry["aiSdkTools"]>[0];
export type AgentRunEventSink = (event: AgentRunEvent) => void;

export class AgentRuntime {
  constructor(private readonly options: AgentRuntimeOptions) {}

  async run(
    request: AgentRunRequest,
    onEvent?: AgentRunEventSink,
    execution: AgentRunExecutionOptions = {}
  ): Promise<AgentRun> {
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
    const routingMode = this.options.agentRoutingMode
      ?? (this.options.enableLayeredRouting === true ? "layered" : "deterministic");
    const useLayeredRouting = routingMode === "layered";
    const modelMetrics = new ModelMetricsRecorder(runTiming);
    const contextBudgetConfig = this.options.contextBudget ?? DEFAULT_CONTEXT_BUDGET;
    const contextBudgetReports: ContextBudgetRequestReport[] = [];
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
    let terminalReason = "Model execution completed.";
    let streamingMessageId: string | undefined;
    let streamingMessageCreatedAt: string | undefined;
    let streamedText = "";
    let finalAssistantMessageEmitted = false;
    const toolRecords: ToolExecutionRecord[] = [];
    const effectivePermissionMode = this.options.actionLevel === "full-access"
      ? "auto"
      : request.permissionMode ?? "auto";
    const effectiveEnabledTools = request.enabledTools;
    let routing: AgentRoutingDecision = {
      mode: routingMode,
      selectedToolIds: [],
      groups: [],
      confidence: { level: "low", score: 0 },
      reasons: ["Routing did not complete."],
      additionalModelStage: {
        used: useLayeredRouting,
        reason: useLayeredRouting
          ? "The temporary layered rollback mode was requested."
          : "The deterministic route did not complete."
      }
    };
    await measurePersistenceWrite(() => stateStore.startRun({ sessionId, runId, startedAt }));
    for (const message of messages) {
      persist(() => stateStore.appendMessage(sessionId, runId, message));
    }
    const storedMarkers = await measurePersistenceWait(() => stateStore.listStateMarkers(sessionId));
    // 待审批工具名：注入到模型上下文（永不折叠/丢弃），保证审批状态持续可见
    const pendingApprovalTools = (await this.options.registry.pendingApprovals())
      .map((approval) => approval.toolName);
    const abortScope = createRunAbortScope(execution.signal, this.options.runTimeoutMs);
    const context = toolContext({
      runId,
      permissionMode: effectivePermissionMode,
      actionLevel: this.options.actionLevel,
      sandboxRoot: this.options.sandboxRoot,
      workspaceRoot: this.options.workspaceRoot,
      sessionId,
      stateMarkers: storedMarkers.map((marker) => marker.key),
      signal: abortScope.signal
    });
    const createRunEvent = (payload: AgentRunEventPayload): AgentRunEvent => {
      return {
        id: crypto.randomUUID(),
        runId,
        createdAt: new Date().toISOString(),
        ...payload
      } as AgentRunEvent;
    };
    const emit = (payload: AgentRunEventPayload) => {
      const runEvent = createRunEvent(payload);
      onEvent?.(runEvent);
      if (runEvent.type !== "text_delta") {
        persist(() => stateStore.recordRunEvent(runEvent));
      }
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
          : `${record.invocation.displayName} ${record.invocation.status}. ${cacheAuditDetail(record.invocation)}`,
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

    };
    const startToolTiming = () => {
      const timing = runTiming.start("tool");
      return () => {
        timing.end();
      };
    };

    try {
      let finalText = "";
      let totalSteps = 0;
      let totalToolResults = 0;

      if (useLayeredRouting) {
        measureRouting(() => toolRouter.build(this.options.registry));
        // ══════════════════════════════════════════════════════════════
        // Phase 1: TRIAGE — 仅核心工具（~7个，~1100 tokens）
        // ══════════════════════════════════════════════════════════════
        const routingIntent = latestUserText(request);
        const triageToolIds = measureRouting(() => toolRouter.filterEligibleToolIds(
          toolRouter.getTriageToolIds(),
          {
            registry: this.options.registry,
            enabledTools: effectiveEnabledTools,
            permissionMode: effectivePermissionMode,
            actionLevel: this.options.actionLevel
          },
          routingIntent
        ));
        const triageAudit = event(
          "model_request",
          "Phase 1: Triage",
          `Layered rollback: sending ${triageToolIds.length} enabled, relevant, and policy-eligible resident tool(s).`
        );
        audit.push(triageAudit);
        persist(() => stateStore.recordAuditEvent(sessionId, runId, triageAudit));
        emit({ type: "audit", audit: triageAudit });

        const triageOnRecord = createOnRecord();
        const triageTools = measureRouting(() => this.options.registry.aiSdkTools(
          context,
          triageToolIds,
          triageOnRecord,
          startToolTiming
        ));
        const triageGeneration = streamText({
          model: modelMetrics.wrap(this.options.model, "triage", triageToolIds.length),
          system: SYSTEM_PROMPT_TRIAGE,
          messages: this.prepareContextMessages(
            "triage",
            request,
            SYSTEM_PROMPT_TRIAGE,
            triageToolIds.length,
            pendingApprovalTools,
            context.stateMarkers,
            contextBudgetReports
          ),
          tools: triageTools,
          stopWhen: stepCountIs(maxTriageRounds),
          temperature: 0.2,
          abortSignal: abortScope.signal
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
        const inferredCategories = measureRouting(() => toolRouter.inferCategories(triageToolCalls, routingIntent));
        const savedTokens = measureRouting(() => toolRouter.estimateTokenSavings(inferredCategories));
        const categorySummary = measureRouting(() => toolRouter.getCategorySummary());
        const specializedToolCount = measureRouting(() => inferredCategories
          .filter((category) => category !== "core-triage")
          .reduce((sum, category) => sum + (categorySummary[category]?.count ?? 0), 0));

        // ══════════════════════════════════════════════════════════════
        // Phase 2: DEEP DIVE — 核心 + 推断的专用工具
        // ══════════════════════════════════════════════════════════════
        const deepOnRecord = createOnRecord();
        const deepCategories = new Set(inferredCategories);
        const deepToolIds = measureRouting(() => toolRouter.filterEligibleToolIds(
          toolRouter.getDeepToolIds([...deepCategories]),
          {
            registry: this.options.registry,
            enabledTools: effectiveEnabledTools,
            permissionMode: effectivePermissionMode,
            actionLevel: this.options.actionLevel
          },
          routingIntent
        ));
        routing = {
          mode: "layered",
          selectedToolIds: deepToolIds,
          groups: [...deepCategories],
          confidence: {
            level: deepCategories.size > 2 ? "medium" : "high",
            score: deepCategories.size > 2 ? 0.65 : 0.85
          },
          reasons: [
            "The temporary layered rollback setting requested a triage model stage.",
            `The triage output and latest user intent selected ${deepCategories.size} routing group(s).`,
            "The selected tools were intersected with enabled tools and current action policy."
          ],
          additionalModelStage: {
            used: true,
            reason: "SECOPS_AGENT_ROUTING_MODE=layered enables the temporary two-stage rollback path."
          }
        };
        const routeAudit = event(
          "routing_decision",
          "Layered rollback route",
          `${routingDetail(routing)} Estimated legacy schema savings: ~${savedTokens} tokens (${categorySummary["core-triage"]?.count ?? 0} core + ${specializedToolCount} specialized tools).`
        );
        audit.push(routeAudit);
        persist(() => stateStore.recordAuditEvent(sessionId, runId, routeAudit));
        emit({ type: "audit", audit: routeAudit });
        const deepTools = measureRouting(() => this.options.registry.aiSdkTools(
          context,
          deepToolIds,
          deepOnRecord,
          startToolTiming
        ));

        // The AI SDK response only contains generated phase messages, so prepend
        // the original valid conversation before the final model execution.
        const deepContextMessages = this.prepareContextMessages(
          "deep",
          request,
          SYSTEM_PROMPT_DEEP,
          deepToolIds.length,
          pendingApprovalTools,
          context.stateMarkers,
          contextBudgetReports
        );
        const phase1Messages = [...deepContextMessages, ...triageResult.response.messages];

        streamingMessageId = crypto.randomUUID();
        streamingMessageCreatedAt = new Date().toISOString();
        streamedText = "";
        const deepGeneration = streamText({
          model: modelMetrics.wrap(this.options.model, "deep", deepToolIds.length),
          system: SYSTEM_PROMPT_DEEP,
          messages: phase1Messages,
          tools: deepTools,
          stopWhen: stepCountIs(maxDeepRounds),
          temperature: 0.2,
          abortSignal: abortScope.signal
        });
        const deepResult = await consumeTextGeneration(
          deepGeneration,
          () => {
            timeToFirstTextMs ??= runTiming.elapsedMs();
          },
          (delta) => {
            streamedText += delta;
            emit({ type: "text_delta", messageId: streamingMessageId as string, delta });
          }
        );
        abortScope.signal.throwIfAborted();

        totalSteps += deepResult.steps.length;
        totalToolResults += deepResult.steps.reduce((c, s) => c + s.toolResults.length, 0);
        finalText = deepResult.text || deepResult.steps.findLast((s) => s.text)?.text || '';
        const deepFinish = deepResult.finishReason === 'tool-calls'
          ? ' [Agent stopped at max tool rounds - increase maxDeepRounds]'
          : '';

        // ── 检查是否有待审批 ──
        if (toolRecords.some((record) => record.invocation.status === "pending_approval")) {
          status = "needs_approval";
          terminalReason = "One or more tool calls require analyst approval.";
        }

        const finalMessage = streamedAssistantMessage(
          streamingMessageId,
          streamingMessageCreatedAt,
          finalText || 'Agent completed but did not produce a final text summary. Check the tool results above.' + deepFinish
        );
        messages.push(finalMessage);
        finalAssistantMessageEmitted = true;
        persist(() => stateStore.appendMessage(sessionId, runId, finalMessage));
        emit({ type: "message", message: finalMessage });

        const responseAudit = event(
          "model_response",
          "Model response",
          `Layered routing complete: Phase 1 (${triageResult.steps.length} steps, ${triageResult.steps.reduce((c, s) => c + s.toolResults.length, 0)} tool results) + Phase 2 (${deepResult.steps.length} steps, ${deepResult.steps.reduce((c, s) => c + s.toolResults.length, 0)} tool results). Total: ${totalSteps} steps, ${totalToolResults} tool results. Finish: ${deepResult.finishReason}.${deepResult.finishReason === "tool-calls" ? " Max tool rounds reached." : ""}`
        );
        audit.push(responseAudit);
        persist(() => stateStore.recordAuditEvent(sessionId, runId, responseAudit));
        emit({ type: "audit", audit: responseAudit });
      } else {
        // ══════════════════════════════════════════════════════════════
        // Deterministic local pre-route followed by one final model execution.
        // ══════════════════════════════════════════════════════════════
        routing = measureRouting(() => toolRouter.route({
          registry: this.options.registry,
          messages: request.messages,
          enabledTools: effectiveEnabledTools,
          permissionMode: effectivePermissionMode,
          actionLevel: this.options.actionLevel
        }));
        const routeAudit = event(
          "routing_decision",
          "Deterministic route",
          routingDetail(routing)
        );
        audit.push(routeAudit);
        persist(() => stateStore.recordAuditEvent(sessionId, runId, routeAudit));
        emit({ type: "audit", audit: routeAudit });

        const requestAudit = event(
          "model_request",
          "Final model request",
          `AI SDK final execution sent to ${this.options.providerLabel} with ${routing.selectedToolIds.length} routed tool(s).`
        );
        audit.push(requestAudit);
        persist(() => stateStore.recordAuditEvent(sessionId, runId, requestAudit));
        emit({ type: "audit", audit: requestAudit });

        const singleTools = measureRouting(() => this.options.registry.aiSdkTools(
          context,
          routing.selectedToolIds,
          createOnRecord(),
          startToolTiming
        ));
        const generation = streamText({
          model: modelMetrics.wrap(
            this.options.model,
            "final",
            Object.keys(singleTools).length
          ),
          system: SYSTEM_PROMPT_FINAL,
          messages: this.prepareContextMessages(
            "final",
            request,
            SYSTEM_PROMPT_FINAL,
            routing.selectedToolIds.length,
            pendingApprovalTools,
            context.stateMarkers,
            contextBudgetReports
          ),
          tools: singleTools,
          stopWhen: stepCountIs(this.options.maxToolRounds ?? 10),
          temperature: 0.2,
          abortSignal: abortScope.signal
        });
        streamingMessageId = crypto.randomUUID();
        streamingMessageCreatedAt = new Date().toISOString();
        streamedText = "";
        const result = await consumeTextGeneration(
          generation,
          () => {
            timeToFirstTextMs ??= runTiming.elapsedMs();
          },
          (delta) => {
            streamedText += delta;
            emit({ type: "text_delta", messageId: streamingMessageId as string, delta });
          }
        );
        abortScope.signal.throwIfAborted();

        if (toolRecords.some((record) => record.invocation.status === "pending_approval")) {
          status = "needs_approval";
          terminalReason = "One or more tool calls require analyst approval.";
        }
        finalText = result.text || result.steps.findLast((s) => s.text)?.text || '';
        const finishInfo = result.finishReason === 'tool-calls' ? ' [Agent stopped at max tool rounds - increase maxToolRounds]' : '';
        const assistantMessage = streamedAssistantMessage(
          streamingMessageId,
          streamingMessageCreatedAt,
          finalText || 'Agent completed but did not produce a final text summary. Check the tool results above.' + finishInfo
        );
        messages.push(assistantMessage);
        finalAssistantMessageEmitted = true;
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
      const abortReason = abortScope.signal.aborted
        ? normalizeAbortReason(abortScope.signal.reason)
        : undefined;
      status = abortReason?.status ?? "failed";
      terminalReason = abortReason?.message ?? errorText(error);
      const errorAudit = event(
        "model_response",
        status === "timed_out" ? "Run timed out" : status === "cancelled" ? "Run cancelled" : "Runtime error",
        terminalReason,
        status === "cancelled" ? "warn" : "error"
      );
      audit.push(errorAudit);
      persist(() => stateStore.recordAuditEvent(sessionId, runId, errorAudit));
      emit({ type: "audit", audit: errorAudit });
      if (!finalAssistantMessageEmitted) {
        const terminalContent = status === "failed"
          ? `Agent run failed: ${terminalReason}`
          : terminalAssistantContent(streamedText, status, terminalReason);
        const terminalMessage = streamingMessageId && streamingMessageCreatedAt
          ? streamedAssistantMessage(streamingMessageId, streamingMessageCreatedAt, terminalContent)
          : chat("assistant", terminalContent);
        messages.push(terminalMessage);
        finalAssistantMessageEmitted = true;
        persist(() => stateStore.appendMessage(sessionId, runId, terminalMessage));
        emit({ type: "message", message: terminalMessage });
      }
    }

    // Flush all queued state writes before taking the run-level snapshot.
    await persistence;
    if (persistenceFailure !== undefined) {
      status = "failed";
      terminalReason = `Persistence failed: ${errorText(persistenceFailure)}`;
      audit.push(event(
        "model_response",
        "Persistence error",
        errorText(persistenceFailure),
        "error"
      ));
    }

    const cacheStats = this.options.registry.cacheStats();
    const cacheHits = toolRecords.filter((record) => record.invocation.cache?.status === "hit").length;
    const cacheMisses = toolRecords.filter((record) => record.invocation.cache?.status === "miss").length;
    const cacheBypasses = toolRecords.filter((record) => record.invocation.cache?.status === "bypass").length;

    const run: AgentRun = {
      id: runId,
      sessionId,
      status,
      terminalReason,
      provider: this.options.providerLabel,
      model: this.options.modelName,
      startedAt,
      completedAt: new Date().toISOString(),
      messages,
      toolInvocations,
      audit,
      artifacts,
      routing,
      metrics: {
        schemaVersion: 1,
        measurementBoundary: "before-completion-export",
        mode: routingMode,
        totalDurationMs: 0,
        localOrchestrationDurationMs: 0,
        localRoutingDurationMs: roundDurationMs(localRoutingDurationMs),
        text: timeToFirstTextMs === undefined
          ? { measurement: "unavailable" }
          : { timeToFirstTextMs, measurement: "provider-stream" },
        model: modelMetrics.snapshot(),
        tools: {
          callCount: toolRecords.length,
          handlerCallCount: toolRecords.filter((record) => record.metrics.handlerCalled).length,
          totalDurationMs: runTiming.totalDurationMs("tool")
        },
        cache: {
          hits: cacheHits,
          misses: cacheMisses,
          bypasses: cacheBypasses,
          size: cacheStats.size,
          evictions: sumToolMetric(toolRecords, "evictions"),
          expiredEntries: sumToolMetric(toolRecords, "expiredEntries"),
          invalidatedEntries: sumToolMetric(toolRecords, "invalidatedEntries"),
          avoidedToolDurationMs: roundDurationMs(sumToolMetric(toolRecords, "avoidedToolDurationMs"))
        },
        persistence: {
          operationCount: persistenceOperationCount,
          totalDurationMs: roundDurationMs(persistenceDurationMs),
          failureCount: persistenceFailureCount
        },
        ...(contextBudgetReports.length > 0
          ? {
              contextBudget: {
                maxInputTokens: contextBudgetConfig.maxInputTokens,
                reservedOutputTokens: contextBudgetConfig.reservedOutputTokens,
                requests: contextBudgetReports
              }
            }
          : {})
      }
    };
    const completionEvent = createRunEvent({ type: "run_completed", run });
    Object.assign(run.metrics, runTiming.snapshot());
    // The completion export is intentionally outside the metrics snapshot boundary.
    try {
      await measurePersistenceWait(() => stateStore.commitRunCompletion(sessionId, run, completionEvent));
      onEvent?.(completionEvent);
      return run;
    } finally {
      abortScope.cleanup();
    }
  }

  /**
   * 为单个模型请求构造预算内上下文；记录预算构成报告。
   * 超预算且无法压缩时抛错（fail early），由 run 的 catch 置为 failed 并给出可操作原因。
   */
  private prepareContextMessages(
    phase: ContextBudgetRequestReport["phase"],
    request: AgentRunRequest,
    systemPrompt: string,
    exposedToolCount: number,
    pendingApprovalTools: string[],
    stateMarkers: string[] | undefined,
    reports: ContextBudgetRequestReport[]
  ): Array<{ role: "user" | "assistant"; content: string; name?: string }> {
    const result = prepareConversationContext({
      messages: request.messages,
      systemPrompt,
      exposedToolCount,
      config: this.options.contextBudget ?? DEFAULT_CONTEXT_BUDGET,
      pendingApprovalTools,
      ...(stateMarkers ? { stateMarkers } : {})
    });
    reports.push({ phase, ...result.report });
    if (result.report.failed) {
      throw new Error(
        result.report.failureReason ?? "Conversation context exceeds the configured token budget."
      );
    }
    return result.messages;
  }
}

async function consumeTextGeneration(
  generation: ReturnType<typeof streamText>,
  onFirstText?: () => void,
  onTextDelta?: (delta: string) => void
) {
  let firstTextSeen = false;
  for await (const part of generation.fullStream) {
    if (!firstTextSeen && part.type === "text-delta" && part.text.length > 0) {
      firstTextSeen = true;
      onFirstText?.();
    }
    if (part.type === "text-delta" && part.text.length > 0) {
      onTextDelta?.(part.text);
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

function sumToolMetric(
  records: ToolExecutionRecord[],
  key: "evictions" | "expiredEntries" | "invalidatedEntries" | "avoidedToolDurationMs"
): number {
  return records.reduce((total, record) => total + record.metrics[key], 0);
}

function cacheAuditDetail(invocation: ToolInvocation): string {
  const cache = invocation.cache;
  if (!cache) {
    return "Cache status unavailable.";
  }
  if (cache.status !== "hit") {
    return `Cache ${cache.status}${cache.reason ? ` (${cache.reason})` : ""}.`;
  }
  return `Cache hit from invocation ${cache.sourceInvocationId ?? "unknown"}, created ${cache.originalCreatedAt ?? "unknown"}, age ${cache.ageMs ?? 0} ms.`;
}

function latestUserText(request: AgentRunRequest): string {
  return [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
}

function routingDetail(routing: AgentRoutingDecision): string {
  return [
    `Mode ${routing.mode}; selected tools [${routing.selectedToolIds.join(", ")}].`,
    `Confidence ${routing.confidence.level} (${routing.confidence.score}).`,
    `Reasons: ${routing.reasons.join(" ")}`,
    `Additional model stage: ${routing.additionalModelStage.used ? "used" : "not used"}; ${routing.additionalModelStage.reason}`
  ].join(" ");
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

function streamedAssistantMessage(id: string | undefined, createdAt: string | undefined, content: string): ChatMessage {
  return {
    id: id ?? crypto.randomUUID(),
    role: "assistant",
    content,
    createdAt: createdAt ?? new Date().toISOString()
  };
}

function terminalAssistantContent(
  partialText: string,
  status: "cancelled" | "timed_out",
  reason: string
): string {
  const notice = status === "timed_out" ? `Agent run timed out: ${reason}` : `Agent run cancelled: ${reason}`;
  return partialText ? `${partialText}\n\n${notice}` : notice;
}

function createRunAbortScope(parentSignal: AbortSignal | undefined, timeoutMs: number | undefined) {
  const controller = new AbortController();
  const abortFromParent = () => {
    controller.abort(parentSignal?.reason ?? {
      status: "cancelled",
      message: "The client cancelled the active run."
    } satisfies AgentRunAbortReason);
  };
  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }
  const timeoutId = timeoutMs && timeoutMs > 0
    ? setTimeout(() => {
        controller.abort({
          status: "timed_out",
          message: `The agent run exceeded its ${timeoutMs} ms execution limit.`
        } satisfies AgentRunAbortReason);
      }, timeoutMs)
    : undefined;
  return {
    signal: controller.signal,
    cleanup() {
      parentSignal?.removeEventListener("abort", abortFromParent);
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  };
}

function normalizeAbortReason(reason: unknown): AgentRunAbortReason {
  if (reason && typeof reason === "object") {
    const candidate = reason as Partial<AgentRunAbortReason>;
    if ((candidate.status === "cancelled" || candidate.status === "timed_out") && typeof candidate.message === "string") {
      return { status: candidate.status, message: candidate.message };
    }
  }
  return {
    status: "cancelled",
    message: errorText(reason) || "The client cancelled the active run."
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error ?? "Unknown error");
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
