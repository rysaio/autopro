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
import { ToolRegistry, type AiSdkToolApprovalOptions } from "../tools/registry.js";
import type { ToolExecutionRecord } from "../tools/types.js";
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
  /** true 时审批中的工具调用会阻塞 generateText，批准/拒绝后模型自动继续。 */
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

    const waitForApproval = this.options.waitForApproval === true;
    const approvalOptions: AiSdkToolApprovalOptions = waitForApproval
      ? this.options.abortSignal
        ? { waitForApproval: true, abortSignal: this.options.abortSignal }
        : { waitForApproval: true }
      : {};

    // ── 缓存写入（创新点） ──
    const cacheToolResult = (record: ToolExecutionRecord) => {
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

    // ── 创建 onRecord 回调工厂 ──
    const createOnRecord = () => (record: ToolExecutionRecord) => {
      const previous = toolRecords.find((existing) => existing.invocation.id === record.invocation.id);
      const resolvingPendingApproval = waitForApproval
        && previous?.invocation.status === "pending_approval"
        && record.invocation.status !== "pending_approval";

      // pending 事件与批准/拒绝后的真实结果使用同一个 toolCallId：
      // 内存、SSE 与持久化存储均按 id 覆盖，避免一张审批卡变成两条记录。
      const recordIndex = toolRecords.findIndex((existing) => existing.invocation.id === record.invocation.id);
      if (recordIndex === -1) {
        toolRecords.push(record);
        toolInvocations.push(record.invocation);
      } else {
        toolRecords[recordIndex] = record;
        toolInvocations[recordIndex] = record.invocation;
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
        cacheToolResult(record);
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
      cacheToolResult(record);
    };

    try {
      // ── 初始化工具路由器 ──
      toolRouter.build(this.options.registry);

      let finalText = "";
      let totalSteps = 0;
      let totalToolResults = 0;

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
        const triageOnRecord = createOnRecord();
        const triageToolIds = toolRouter.getTriageToolIds();
        const triageResult = await generateText({
          model: this.options.model,
          system: systemPromptWithSkills(SYSTEM_PROMPT_TRIAGE, skillSummary),
          messages: request.messages
            .filter((message) => message.role === "user" || message.role === "assistant")
            .map((message) => ({
              role: message.role === "assistant" ? "assistant" as const : "user" as const,
              content: message.content
            })),
          tools: this.options.registry.aiSdkTools(context, triageToolIds, triageOnRecord, approvalOptions),
          stopWhen: stepCountIs(maxTriageRounds),
          temperature: 0.2,
          ...(this.options.abortSignal ? { abortSignal: this.options.abortSignal } : {})
        });

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
        const inferredCategories = toolRouter.inferCategories(triageToolCalls, userMessage);
        const savedTokens = toolRouter.estimateTokenSavings(inferredCategories);

        const routeAudit = event(
          "model_request",
          "Phase 2: Deep Dive",
          `Routing: inferred categories [${inferredCategories.join(", ")}], estimated token savings: ~${savedTokens} tokens (${toolRouter.getCategorySummary()["core-triage"]?.count ?? 0} core + ${inferredCategories.filter((c) => c !== "core-triage").reduce((sum, c) => sum + (toolRouter.getCategorySummary()[c]?.count ?? 0), 0)} specialized tools)`
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
        const deepToolIds = toolRouter.getDeepToolIds([...deepCategories]);

        // 使用 Phase 1 的完整消息历史作为 Phase 2 的输入
        const phase1Messages = triageResult.response.messages;

        const deepResult = await generateText({
          model: this.options.model,
          system: systemPromptWithSkills(SYSTEM_PROMPT_DEEP, skillSummary),
          messages: phase1Messages,
          tools: this.options.registry.aiSdkTools(context, deepToolIds, deepOnRecord, approvalOptions),
          stopWhen: stepCountIs(maxDeepRounds),
          temperature: 0.2,
          ...(this.options.abortSignal ? { abortSignal: this.options.abortSignal } : {})
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

        const result = await generateText({
          model: this.options.model,
          system: systemPromptWithSkills(SYSTEM_PROMPT_DEEP, skillSummary),
          messages: request.messages
            .filter((message) => message.role === "user" || message.role === "assistant")
            .map((message) => ({
              role: message.role === "assistant" ? "assistant" as const : "user" as const,
              content: message.content
            })),
          tools: this.options.registry.aiSdkTools(
            context,
            effectiveEnabledTools,
            createOnRecord(),
            approvalOptions
          ),
          stopWhen: stepCountIs(this.options.maxToolRounds ?? 10),
          temperature: 0.2,
          ...(this.options.abortSignal ? { abortSignal: this.options.abortSignal } : {})
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

    // ── 缓存统计 ──
    const cacheStats = this.toolCache.stats();
    if (cacheStats.hits > 0) {
      console.log(`[ToolCache] Run ${runId}: ${cacheStats.hits} hits, ${cacheStats.misses} misses, hit rate ${Math.round(this.toolCache.hitRate() * 100)}%, ~${cacheStats.savedTokensEstimate} tokens saved`);
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
