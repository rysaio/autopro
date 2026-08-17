import type {
  AgentRun,
  AgentRunEvent,
  AgentRunRequest,
  AuditEvent,
  ChatMessage,
  EvidenceArtifact,
  ToolInvocation
} from "@secops-agent/shared";
import { stepCountIs, streamText, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { ToolRegistry, type AiSdkToolApprovalOptions } from "../tools/registry.js";
import type { ToolExecutionRecord } from "../tools/types.js";
import { NoopSessionStateStore, type SessionStateStore, type StateMarker } from "./sessionStateStore.js";
import { SYSTEM_PROMPT_TRIAGE, SYSTEM_PROMPT_DEEP } from "./systemPrompt.js";
import { systemPromptWithSkills } from "./systemPrompt.js";
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
  /** true 时审批中的工具调用会阻塞 streamText，批准/拒绝后模型自动继续。 */
  waitForApproval?: boolean;
  /** 客户端断开时取消正在等待审批的模型运行。 */
  abortSignal?: AbortSignal;
  /** 分诊阶段最大工具轮数（默认 3） */
  maxTriageRounds?: number;
  /** 深度阶段最大工具轮数（默认 8） */
  maxDeepRounds?: number;
  /** 启用分层工具路由（默认 true） */
  enableLayeredRouting?: boolean;
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
    const maxTriageRounds = this.options.maxTriageRounds ?? 3;
    const maxDeepRounds = this.options.maxDeepRounds ?? 8;
    const useLayeredRouting = this.options.enableLayeredRouting !== false;
    let status: AgentRun["status"] = "completed";
    const toolRecords: ToolExecutionRecord[] = [];
    const effectivePermissionMode = this.options.actionLevel === "full-access"
      ? "auto"
      : request.permissionMode ?? "auto";
    const effectiveEnabledTools = this.options.actionLevel === "full-access"
      ? undefined
      : request.enabledTools;
    const skillSummary = this.options.skillCatalog?.promptSummary() ?? "";
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
    const emit = (
      payload: Omit<AgentRunEvent, "id" | "runId" | "createdAt"> & { streaming?: boolean },
      options?: { persist?: boolean }
    ) => {
      const event = {
        id: crypto.randomUUID(),
        runId,
        createdAt: new Date().toISOString(),
        ...payload
      } as AgentRunEvent & { streaming?: boolean };
      onEvent?.(event);
      if (options?.persist !== false) {
        persist(() => stateStore.recordRunEvent(event));
      }
    };
    emit({ type: "run_started" });

    const waitForApproval = this.options.waitForApproval === true;
    const approvalOptions: AiSdkToolApprovalOptions = waitForApproval
      ? this.options.abortSignal
        ? { waitForApproval: true, abortSignal: this.options.abortSignal }
        : { waitForApproval: true }
      : {};

    // ── 创建 onRecord 回调工厂 ──
    // 用 Map 替代 find/findIndex，工具调用数量增长时保持 O(1) 更新。
    const toolRecordIndex = new Map<string, number>();
    const createOnRecord = () => (record: ToolExecutionRecord) => {
      const existingIndex = toolRecordIndex.get(record.invocation.id);
      const previous = existingIndex === undefined ? undefined : toolRecords[existingIndex];
      const resolvingPendingApproval = waitForApproval
        && previous?.invocation.status === "pending_approval"
        && record.invocation.status !== "pending_approval";

      // pending 事件与批准/拒绝后的真实结果使用同一个 toolCallId：
      // 内存、SSE 与持久化存储均按 id 覆盖，避免一张审批卡变成两条记录。
      if (existingIndex === undefined) {
        toolRecords.push(record);
        toolInvocations.push(record.invocation);
        toolRecordIndex.set(record.invocation.id, toolRecords.length - 1);
      } else {
        toolRecords[existingIndex] = record;
        toolInvocations[existingIndex] = record.invocation;
      }
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

      if (resolvingPendingApproval) {
        const resultAudit = event(
          "tool_result",
          "Tool result",
          record.invocation.guidance
            ? `${record.invocation.displayName} returned recoverable guidance: ${record.invocation.guidance.message}`
            : `${record.invocation.displayName} ${record.invocation.status} after analyst decision.`,
          record.invocation.guidance || record.invocation.status === "denied" || record.invocation.status === "failed" ? "warn" : "info"
        );
        audit.push(resultAudit);
        persist(() => stateStore.recordAuditEvent(sessionId, runId, resultAudit));
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
        return;
      }

      if (waitForApproval && record.invocation.status === "pending_approval") {
        const requestedAudit = event("tool_requested", "Tool requested", record.invocation.toolName);
        const policyAudit = event(
          "policy_decision",
          "Approval requested",
          `${record.invocation.displayName} requires analyst approval under ${effectivePermissionMode} mode.`,
          "warn"
        );
        audit.push(requestedAudit, policyAudit);
        persist(() => stateStore.recordAuditEvent(sessionId, runId, requestedAudit));
        persist(() => stateStore.recordAuditEvent(sessionId, runId, policyAudit));
        emit({ type: "audit", audit: requestedAudit });
        emit({ type: "audit", audit: policyAudit });
        return;
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
    };

    // ── 流式消息：把 LLM 输出按真实发生顺序推给前端 ──
    // stream=false 时只内部收集，不推送到前端也不持久化；
    // 由调用方在决策后决定是否发布为最终回复。
    const createStreamingMessage = (name?: string, stream = true) => {
      let current: ChatMessage | null = null;
      let lastEmitAt = 0;
      const start = () => {
        current = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: "",
          createdAt: new Date().toISOString()
        };
        if (name) {
          current.name = name;
        }
      };
      const delta = (chunk: string) => {
        if (!current) {
          start();
        }
        if (current) {
          current.content += chunk;
          if (!stream) {
            return;
          }
          const now = Date.now();
          // 节流：部分更新最多每 50ms 推送一次，最终消息在 finalize 时完整推送。
          if (now - lastEmitAt >= 50) {
            lastEmitAt = now;
            emit({ type: "message", message: { ...current }, streaming: true }, { persist: false });
          }
        }
      };
      const finalize = (): ChatMessage | null => {
        const message = current;
        current = null;
        if (!message || message.content.length === 0) {
          return null;
        }
        if (stream) {
          messages.push(message);
          persist(() => stateStore.appendMessage(sessionId, runId, message));
          emit({ type: "message", message });
        }
        return message;
      };
      return { start, delta, finalize };
    };

    // ── 将分诊阶段内部收集的最终消息以流式方式发布 ──
    // 决策为“仅 Phase 1”时，用户仍然看到连续输出，而不是突然冒出一整段。
    const publishBufferedMessage = async (message: ChatMessage) => {
      const chunkSize = 48;
      for (let offset = 0; offset < message.content.length; offset += chunkSize) {
        const partial: ChatMessage = {
          ...message,
          content: message.content.slice(0, offset + chunkSize)
        };
        emit({ type: "message", message: partial, streaming: true }, { persist: false });
        await new Promise((resolve) => setTimeout(resolve, 8));
      }
      messages.push(message);
      persist(() => stateStore.appendMessage(sessionId, runId, message));
      emit({ type: "message", message });
    };

    // ── 单个 streamText 阶段：消费 fullStream，按模型实际动作顺序转发事件 ──
    const runStreamPhase = async (options: {
      system: string;
      messages: ModelMessage[];
      tools: ToolSet;
      stopWhen: ReturnType<typeof stepCountIs>;
      /** false 时只收集 assistant 文本，不向前端推送、不持久化；用于分诊阶段的中间文本。 */
      streamText?: boolean;
    }): Promise<{
      text: string;
      finishReason: string;
      stepCount: number;
      toolResultCount: number;
      toolCallNames: string[];
      responseMessages: ModelMessage[];
      finalAssistantMessage: ChatMessage | null;
    }> => {
      const textMessage = createStreamingMessage(undefined, options.streamText !== false);
      const reasoningMessage = createStreamingMessage("thinking");
      let finishReason = "";
      let stepCount = 0;
      let toolResultCount = 0;
      const toolCallNames: string[] = [];
      let finalAssistantMessage: ChatMessage | null = null;

      try {
        const result = streamText({
          model: this.options.model,
          system: options.system,
          messages: options.messages,
          tools: options.tools,
          stopWhen: options.stopWhen,
          temperature: 0.2,
          ...(this.options.abortSignal ? { abortSignal: this.options.abortSignal } : {})
        });

        for await (const part of result.fullStream) {
          switch (part.type) {
            case "start-step":
              stepCount += 1;
              break;
            case "reasoning-start":
              reasoningMessage.start();
              break;
            case "reasoning-delta":
              reasoningMessage.delta(part.text);
              break;
            case "reasoning-end":
              reasoningMessage.finalize();
              break;
            case "text-start":
              textMessage.start();
              break;
            case "text-delta":
              textMessage.delta(part.text);
              break;
            case "text-end":
              finalAssistantMessage = textMessage.finalize() ?? finalAssistantMessage;
              break;
            case "tool-call":
              // 文本/思考先于工具调用完成：在工具卡片出现前落定消息。
              finalAssistantMessage = textMessage.finalize() ?? finalAssistantMessage;
              reasoningMessage.finalize();
              toolCallNames.push(part.toolName);
              break;
            case "tool-result":
              toolResultCount += 1;
              break;
            case "finish":
              finishReason = part.finishReason;
              break;
            case "error":
              throw part.error instanceof Error ? part.error : new Error(String(part.error));
            default:
              break;
          }
        }

        finalAssistantMessage = textMessage.finalize() ?? finalAssistantMessage;
        reasoningMessage.finalize();

        let text = "";
        let finish = finishReason;
        let responseMessages: ModelMessage[] = [];
        try {
          text = await result.text;
        } catch {
          // fullStream 已消费完；这里兜底用流式阶段收集到的内容。
        }
        try {
          finish = await result.finishReason;
        } catch {
          // 使用 fullStream 中的 finish 事件值。
        }
        try {
          responseMessages = (await result.response).messages;
        } catch {
          responseMessages = [];
        }

        return {
          text: text || finalAssistantMessage?.content || "",
          finishReason: finish !== "other" ? finish : finishReason,
          stepCount,
          toolResultCount,
          toolCallNames,
          responseMessages,
          finalAssistantMessage
        };
      } finally {
        textMessage.finalize();
        reasoningMessage.finalize();
      }
    };

    try {
      // ── 初始化工具路由器 ──
      toolRouter.build(this.options.registry);

      let finalText = "";
      let totalSteps = 0;
      let totalToolResults = 0;
      const requestModelMessages = request.messages
        .filter((message) => message.role === "user" || message.role === "assistant")
        .map((message) => ({
          role: message.role === "assistant" ? "assistant" as const : "user" as const,
          content: message.content
        }));

      if (useLayeredRouting) {
        // ══════════════════════════════════════════════════════════════
        // Phase 1: TRIAGE — 仅核心工具（~7个，~1100 tokens）
        // ══════════════════════════════════════════════════════════════
        const triageCategory = toolRouter.getCategorySummary()["core-triage"];
        const triageAudit = event(
          "model_request",
          "Phase 1: Triage",
          `Layered routing: sending core triage tools (${triageCategory?.count ?? 0} tools, ~${triageCategory?.tokens ?? 0} tokens)`
        );
        audit.push(triageAudit);
        persist(() => stateStore.recordAuditEvent(sessionId, runId, triageAudit));
        emit({ type: "audit", audit: triageAudit });

        // 使用 registry 直接生成 triage 工具集，带上 onRecord 以追踪结果
        const triageToolIds = toolRouter.getTriageToolIds();
        const triageResult = await runStreamPhase({
          system: systemPromptWithSkills(SYSTEM_PROMPT_TRIAGE, skillSummary),
          messages: requestModelMessages,
          tools: this.options.registry.aiSdkTools(context, triageToolIds, createOnRecord(), approvalOptions),
          stopWhen: stepCountIs(maxTriageRounds),
          streamText: false
        });

        totalSteps += triageResult.stepCount;
        totalToolResults += triageResult.toolResultCount;

        // 收集 Phase 1 中调用的工具名和用户消息，推断进入 Deep Dive 时应加载的专用工具类别。
        const triageToolCalls = triageResult.toolCallNames;
        const userMessage = request.messages
          .filter((m) => m.role === "user")
          .map((m) => m.content)
          .join(" ");
        const inferredCategories = toolRouter.inferCategories(triageToolCalls, userMessage);
        const savedTokens = toolRouter.estimateTokenSavings(inferredCategories);

        // ── 决策：是否进入 Deep Dive ──
        // 规则：1) Phase 1 没有最终文本；2) 因 tool-calls 达到轮次上限；
        //       3) Deep Dive 相对 Triage 能加载新工具（关键词或工具调用命中）。
        const triageFinal = triageResult.finalAssistantMessage;
        const triageToolIdSet = new Set(triageToolIds);
        const decisionToolIds = toolRouter.getDeepToolIds(inferredCategories);
        const hasSpecializedTools = decisionToolIds.some((id) => !triageToolIdSet.has(id));
        const shouldRunDeep = !triageFinal
          || triageResult.finishReason === "tool-calls"
          || hasSpecializedTools;

        const routeAudit = event(
          "model_request",
          shouldRunDeep ? "Phase 2: Deep Dive" : "Phase 2: Skipped",
          shouldRunDeep
            ? `Routing: inferred categories [${inferredCategories.join(", ")}], estimated token savings: ~${savedTokens} tokens. Phase 1 final text ${triageFinal ? "present" : "missing"}, finish ${triageResult.finishReason}, specialized tools ${hasSpecializedTools ? "required" : "not required"}.`
            : `Routing: inferred categories [${inferredCategories.join(", ")}] can be satisfied by triage tools. Phase 1 final text will be published as the only reply.`
        );
        audit.push(routeAudit);
        persist(() => stateStore.recordAuditEvent(sessionId, runId, routeAudit));
        emit({ type: "audit", audit: routeAudit });

        let responseDetail = "";
        if (shouldRunDeep) {
          // ══════════════════════════════════════════════════════════════
          // Phase 2: DEEP DIVE — 核心 + 推断的专用工具
          // ══════════════════════════════════════════════════════════════
          const deepOnRecord = createOnRecord();
          // 动作工具（sandbox-actions）固定加载：保证 action 工具永远可达，
          // 不依赖关键词推断（“拉黑/记笔记”等说法可能不在推断表内）
          const deepCategories = new Set(inferredCategories);
          deepCategories.add("sandbox-actions");
          const deepToolIds = toolRouter.getDeepToolIds([...deepCategories]);

          // 使用 Phase 1 的完整消息历史作为 Phase 2 的输入
          const deepResult = await runStreamPhase({
            system: systemPromptWithSkills(SYSTEM_PROMPT_DEEP, skillSummary),
            messages: [...requestModelMessages, ...triageResult.responseMessages],
            tools: this.options.registry.aiSdkTools(context, deepToolIds, deepOnRecord, approvalOptions),
            stopWhen: stepCountIs(maxDeepRounds)
          });

          totalSteps += deepResult.stepCount;
          totalToolResults += deepResult.toolResultCount;
          finalText = deepResult.text || deepResult.finalAssistantMessage?.content || "";

          const deepFinish = deepResult.finishReason === "tool-calls"
            ? " [Agent stopped at max tool rounds - increase maxDeepRounds]"
            : "";

          // 流式阶段已经输出过 assistant 消息则不再重复；否则补一条兜底消息。
          if (!deepResult.finalAssistantMessage) {
            const finalMessage = chat(
              "assistant",
              finalText || `Agent completed but did not produce a final text summary. Check the tool results above.${deepFinish}`
            );
            messages.push(finalMessage);
            persist(() => stateStore.appendMessage(sessionId, runId, finalMessage));
            emit({ type: "message", message: finalMessage });
          }
          responseDetail = `Layered routing complete: Phase 1 (${triageResult.stepCount} steps, ${triageResult.toolResultCount} tool results) + Phase 2 (${deepResult.stepCount} steps, ${deepResult.toolResultCount} tool results). Total: ${totalSteps} steps, ${totalToolResults} tool results. Cache: ${Math.round(this.options.registry.cache.hitRate() * 100)}% hit rate, ~${this.options.registry.cache.stats().savedTokensEstimate} tokens saved. Finish: ${deepResult.finishReason}.${deepResult.finishReason === "tool-calls" ? " Max tool rounds reached." : ""}`;
        } else {
          // 无需 Deep Dive：把 Phase 1 最终文本作为本轮唯一模型回复流式发布。
          finalText = triageFinal?.content || triageResult.text || "";
          if (triageFinal) {
            await publishBufferedMessage(triageFinal);
          } else {
            const finalMessage = chat(
              "assistant",
              finalText || "Agent completed but did not produce a final text summary."
            );
            await publishBufferedMessage(finalMessage);
          }
          responseDetail = `Layered routing complete: Phase 1 only (${triageResult.stepCount} steps, ${triageResult.toolResultCount} tool results). Deep Dive skipped. Total: ${totalSteps} steps, ${totalToolResults} tool results. Cache: ${Math.round(this.options.registry.cache.hitRate() * 100)}% hit rate, ~${this.options.registry.cache.stats().savedTokensEstimate} tokens saved. Finish: ${triageResult.finishReason}.`;
        }

        // ── 检查是否有待审批 ──
        if (toolRecords.some((record) => record.invocation.status === "pending_approval")) {
          status = "needs_approval";
        }

        const responseAudit = event(
          "model_response",
          "Model response",
          responseDetail
        );
        audit.push(responseAudit);
        persist(() => stateStore.recordAuditEvent(sessionId, runId, responseAudit));
        emit({ type: "audit", audit: responseAudit });
      } else {
        // ══════════════════════════════════════════════════════════════
        // 传统模式：全部工具一次性发送（向后兼容）
        // ══════════════════════════════════════════════════════════════
        const requestAudit = event("model_request", "Model request", `AI SDK stream sent to ${this.options.providerLabel}.`);
        audit.push(requestAudit);
        persist(() => stateStore.recordAuditEvent(sessionId, runId, requestAudit));
        emit({ type: "audit", audit: requestAudit });

        const result = await runStreamPhase({
          system: systemPromptWithSkills(SYSTEM_PROMPT_DEEP, skillSummary),
          messages: requestModelMessages,
          tools: this.options.registry.aiSdkTools(
            context,
            effectiveEnabledTools,
            createOnRecord(),
            approvalOptions
          ),
          stopWhen: stepCountIs(this.options.maxToolRounds ?? 10)
        });

        if (toolRecords.some((record) => record.invocation.status === "pending_approval")) {
          status = "needs_approval";
        }
        totalSteps = result.stepCount;
        totalToolResults = result.toolResultCount;
        finalText = result.text || result.finalAssistantMessage?.content || "";
        const finishInfo = result.finishReason === "tool-calls"
          ? " [Agent stopped at max tool rounds - increase maxToolRounds]"
          : "";
        if (!result.finalAssistantMessage) {
          const assistantMessage = chat(
            "assistant",
            finalText || `Agent completed but did not produce a final text summary. Check the tool results above.${finishInfo}`
          );
          messages.push(assistantMessage);
          persist(() => stateStore.appendMessage(sessionId, runId, assistantMessage));
          emit({ type: "message", message: assistantMessage });
        }
        const responseAudit = event(
          "model_response",
          "Model response",
          `AI SDK stream finished with ${result.stepCount} step(s), ${result.toolResultCount} tool result(s), finish reason ${result.finishReason}.${result.finishReason === "tool-calls" ? " Max tool rounds reached before final response." : ""}`
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

    // ── 缓存统计 ──
    const cacheStats = this.options.registry.cache.stats();
    if (cacheStats.hits > 0) {
      console.log(`[ToolCache] Run ${runId}: ${cacheStats.hits} hits, ${cacheStats.misses} misses, hit rate ${Math.round(this.options.registry.cache.hitRate() * 100)}%, ~${cacheStats.savedTokensEstimate} tokens saved`);
    }

    const run = {
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
