import type { ChatMessage } from "@secops-agent/shared";

/** 与 AgentRunRequest 消息兼容的宽松消息类型（id 可选）。 */
export type ContextMessage = Pick<ChatMessage, "role" | "content"> & {
  id?: string;
  createdAt?: string;
  name?: string;
  toolCallId?: string;
};

export interface ContextBudgetConfig {
  /** 每个模型请求的输入预算（tokens）。 */
  maxInputTokens: number;
  /** 预留输出 token 数（不计入输入预算，单独报告）。 */
  reservedOutputTokens: number;
  /** 超预算时保留的最近 user/assistant 消息条数（最新用户消息总是保留）。 */
  keepRecentMessages: number;
}

export interface ContextBudgetRequestReport {
  phase: string;
  systemPromptTokens: number;
  conversationHistoryTokens: number;
  toolsTokens: number;
  reservedOutputTokens: number;
  totalInputTokens: number;
  withinBudget: boolean;
  /** 被折叠为 summary 的更早消息条数。 */
  summarizedMessages: number;
  /** 因摘要预算不足而完全未进入上下文的更早消息条数。 */
  droppedMessages: number;
}

export interface ConversationContextResult {
  messages: Array<{ role: "user" | "assistant"; content: string; name?: string }>;
  report: Omit<ContextBudgetRequestReport, "phase"> & {
    failed: boolean;
    failureReason?: string;
  };
}

/** 与 toolRouter 保持一致的平均工具 schema token 估算。 */
export const AVG_TOKENS_PER_TOOL = 160;

/** 用户批准的服务端默认上下文预算：输入 64k + 预留输出 4k，保留最近 10 条原文。 */
export const DEFAULT_CONTEXT_BUDGET: ContextBudgetConfig = {
  maxInputTokens: 64_000,
  reservedOutputTokens: 4_000,
  keepRecentMessages: 10
};

/**
 * 保守 token 估算：ASCII 约 4 chars/token，非 ASCII（中文等）按 1 char/token。
 * 纯本地近似，不发起任何额外模型请求。
 */
export function estimateTokens(text: string): number {
  let weight = 0;
  for (const char of text) {
    weight += (char.codePointAt(0) ?? 0) > 0x7f ? 1 : 0.25;
  }
  return Math.ceil(weight);
}

/**
 * 为单个模型请求构造有界上下文：
 * - 短对话（估算在预算内）原样透传，不做任何压缩；
 * - 长对话保留最新用户请求 + 最近 keepRecentMessages 条原文，更早历史折叠为
 *   一条带 `context-summary` 标记的 summary 消息；
 * - pending approvals 与 active state markers 以 `state-context` 消息注入，永不折叠/丢弃；
 * - 折叠后仍超预算 → failed=true（fail early，带可操作原因）。
 * Summary 只进入本次请求，不写回会话存储，不替代权威 tool/approval 记录。
 */
export function prepareConversationContext(input: {
  messages: ContextMessage[];
  systemPrompt: string;
  exposedToolCount: number;
  config: ContextBudgetConfig;
  pendingApprovalTools?: string[];
  stateMarkers?: string[];
}): ConversationContextResult {
  const { messages, systemPrompt, exposedToolCount, config } = input;
  const systemPromptTokens = estimateTokens(systemPrompt);
  const toolsTokens = exposedToolCount * AVG_TOKENS_PER_TOOL;
  const history = messages.filter((message) => message.role === "user" || message.role === "assistant");
  const historyTokens = history.reduce((sum, message) => sum + estimateTokens(message.content), 0);
  const inputBudget = config.maxInputTokens;
  const baseTokens = systemPromptTokens + toolsTokens;

  // 权威状态：approval state 与 active state markers 永不折叠/丢弃
  const stateParts: string[] = [];
  if (input.pendingApprovalTools?.length) {
    stateParts.push(`Pending approvals awaiting analyst decision: ${input.pendingApprovalTools.join(", ")}`);
  }
  if (input.stateMarkers?.length) {
    stateParts.push(`Active investigation state markers: ${input.stateMarkers.join(", ")}`);
  }
  const stateText = stateParts.join("\n");
  const stateTokens = stateText ? estimateTokens(stateText) : 0;

  // 预算内：短对话原样透传（不折叠、不额外请求）；如有权威状态则附加 state-context
  if (baseTokens + historyTokens + stateTokens <= inputBudget) {
    return {
      messages: [
        ...(stateText ? [{ role: "assistant" as const, content: stateText, name: "state-context" as const }] : []),
        ...history.map(toModelMessage)
      ],
      report: {
        systemPromptTokens,
        conversationHistoryTokens: historyTokens,
        toolsTokens,
        reservedOutputTokens: config.reservedOutputTokens,
        totalInputTokens: baseTokens + historyTokens + stateTokens,
        withinBudget: true,
        summarizedMessages: 0,
        droppedMessages: 0,
        failed: false
      }
    };
  }

  // 压缩：最新用户消息必保，再补足最近 keepRecentMessages 条原文
  const keep = Math.max(1, config.keepRecentMessages);
  const latestUserIndex = history.map((message) => message.role).lastIndexOf("user");
  const latestUser = latestUserIndex >= 0 ? history[latestUserIndex] : undefined;
  const retained: ContextMessage[] = [];
  const retainedSet = new Set<ContextMessage>();
  if (latestUser) {
    retained.push(latestUser);
    retainedSet.add(latestUser);
  }
  for (let index = history.length - 1; index >= 0 && retained.length < keep; index -= 1) {
    const candidate = history[index];
    if (candidate && !retainedSet.has(candidate)) {
      retained.push(candidate);
      retainedSet.add(candidate);
    }
  }
  retained.reverse();
  const older = history.filter((message) => !retainedSet.has(message));

  // 摘要预算 = 输入预算 - system - tools - 保留集 - 状态注入
  const retainedTokens = retained.reduce((sum, message) => sum + estimateTokens(message.content), 0)
    + (stateText ? estimateTokens(stateText) : 0);
  const summaryBudget = Math.max(0, inputBudget - baseTokens - retainedTokens);

  // 逐条把更早消息装入摘要；装不下的计为 dropped（fail early 语义：仍超则失败）
  const summaryParts: string[] = [];
  let used = 0;
  let droppedMessages = 0;
  for (const olderMessage of older) {
    const part = `${olderMessage.role}: ${olderMessage.content}`;
    const partTokens = estimateTokens(part) + (summaryParts.length ? 1 : 0);
    if (summaryBudget > 0 && used + partTokens <= summaryBudget) {
      summaryParts.push(part);
      used += partTokens;
    } else {
      droppedMessages += 1;
    }
  }
  const summarizedMessages = older.length;
  const summaryText = summaryParts.length
    ? `[历史摘要] 更早对话共 ${summarizedMessages} 条，以下为压缩摘要：${summaryParts.join(" | ")}`
    : "";

  const modelMessages: Array<{ role: "user" | "assistant"; content: string; name?: string }> = [];
  if (summaryText) {
    modelMessages.push({ role: "assistant", content: summaryText, name: "context-summary" });
  }
  if (stateText) {
    modelMessages.push({ role: "assistant", content: stateText, name: "state-context" });
  }
  modelMessages.push(...retained.map(toModelMessage));

  const totalInputTokens = baseTokens + modelMessages.reduce(
    (sum, message) => sum + estimateTokens(message.content),
    0
  );
  const withinBudget = totalInputTokens <= inputBudget;
  if (!withinBudget) {
    return {
      messages: [],
      report: {
        systemPromptTokens,
        conversationHistoryTokens: historyTokens,
        toolsTokens,
        reservedOutputTokens: config.reservedOutputTokens,
        totalInputTokens,
        withinBudget: false,
        summarizedMessages,
        droppedMessages,
        failed: true,
        failureReason:
          `Conversation context (${totalInputTokens} tokens) exceeds the configured ${inputBudget}-token input budget ` +
          `(system ${systemPromptTokens} + history ${historyTokens} + tools ${toolsTokens}) ` +
          `even after summarizing ${summarizedMessages} older messages. Start a new session or raise SECOPS_CONTEXT_BUDGET_INPUT_TOKENS.`
      }
    };
  }
  return {
    messages: modelMessages,
    report: {
      systemPromptTokens,
      conversationHistoryTokens: historyTokens,
      toolsTokens,
      reservedOutputTokens: config.reservedOutputTokens,
      totalInputTokens,
      withinBudget,
      summarizedMessages,
      droppedMessages,
      failed: false
    }
  };
}

function toModelMessage(message: ContextMessage): { role: "user" | "assistant"; content: string } {
  return {
    role: message.role === "assistant" ? "assistant" : "user",
    content: message.content
  };
}
