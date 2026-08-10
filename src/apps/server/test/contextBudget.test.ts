import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@secops-agent/shared";
import {
  estimateTokens,
  prepareConversationContext,
  type ContextBudgetConfig
} from "../src/runtime/contextBudget.js";

function message(role: "user" | "assistant", content: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString()
  };
}

function history(roles: Array<"user" | "assistant">): ChatMessage[] {
  return roles.map((role, index) => message(role, `message-${index + 1} ${"x".repeat(100)}`));
}

const smallBudget: ContextBudgetConfig = {
  maxInputTokens: 2_000,
  reservedOutputTokens: 500,
  keepRecentMessages: 3
};

describe("contextBudget", () => {
  it("estimates tokens conservatively (ASCII ~4 chars/token, non-ASCII 1 char/token)", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcd" + "e".repeat(100))).toBe(26);
    expect(estimateTokens("中文中文")).toBe(4);
  });

  it("passes short conversations through unchanged without extra requests", () => {
    const messages = history(["user", "assistant", "user"]);
    const result = prepareConversationContext({
      messages,
      systemPrompt: "short system",
      exposedToolCount: 2,
      config: { maxInputTokens: 64_000, reservedOutputTokens: 4_000, keepRecentMessages: 10 }
    });

    expect(result.report.failed).toBe(false);
    expect(result.report.withinBudget).toBe(true);
    expect(result.report.summarizedMessages).toBe(0);
    expect(result.report.droppedMessages).toBe(0);
    // 原样透传：无 summary 标记，消息条数一致
    expect(result.messages.some((m) => m.name === "context-summary")).toBe(false);
    expect(result.messages).toHaveLength(3);
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("summarizes older history while keeping the latest user request and recent messages verbatim", () => {
    const messages = history(["user", "assistant", "user", "assistant", "user", "assistant", "user"]);
    const result = prepareConversationContext({
      messages,
      systemPrompt: "system",
      exposedToolCount: 0,
      config: { maxInputTokens: 167, reservedOutputTokens: 100, keepRecentMessages: 3 }
    });

    expect(result.report.failed).toBe(false);
    expect(result.report.summarizedMessages).toBe(4);
    // 最新用户消息必保
    expect(result.messages.at(-1)?.content).toBe(messages.at(-1)?.content);
    expect(result.messages.at(-1)?.role).toBe("user");
    // 保留集 = 最近 3 条原文（u7, a6, u5），更早 4 条折叠为标记 summary
    const summary = result.messages.find((m) => m.name === "context-summary");
    expect(summary).toBeDefined();
    expect(summary?.content).toContain("[历史摘要]");
    expect(result.messages.filter((m) => !m.name)).toHaveLength(3);
    expect(result.report.withinBudget).toBe(true);
  });

  it("injects pending approvals and active state markers as non-droppable state context", () => {
    const messages = history(["user", "assistant", "user"]);
    const result = prepareConversationContext({
      messages,
      systemPrompt: "system",
      exposedToolCount: 0,
      config: smallBudget,
      pendingApprovalTools: ["demo.block"],
      stateMarkers: ["compromised-host-1", "lateral-movement-detected"]
    });

    const state = result.messages.find((m) => m.name === "state-context");
    expect(state).toBeDefined();
    expect(state?.content).toContain("demo.block");
    expect(state?.content).toContain("compromised-host-1");
    expect(state?.content).toContain("lateral-movement-detected");
  });

  it("fails early with an actionable reason when even the retained set exceeds the budget", () => {
    const oversized = message("user", "严重告警，需要持续调查".repeat(4_000));
    const result = prepareConversationContext({
      messages: [oversized],
      systemPrompt: "system prompt text",
      exposedToolCount: 0,
      config: { maxInputTokens: 1_000, reservedOutputTokens: 100, keepRecentMessages: 1 }
    });

    expect(result.report.failed).toBe(true);
    expect(result.report.withinBudget).toBe(false);
    expect(result.report.failureReason).toContain("input budget");
    expect(result.report.failureReason).toContain("SECOPS_CONTEXT_BUDGET_INPUT_TOKENS");
    expect(result.messages).toEqual([]);
  });

  it("reports the per-request budget breakdown for every model request", () => {
    const result = prepareConversationContext({
      messages: history(["user", "assistant", "user"]),
      systemPrompt: "system",
      exposedToolCount: 5,
      config: smallBudget
    });
    const report = result.report;
    expect(report.systemPromptTokens).toBeGreaterThan(0);
    expect(report.conversationHistoryTokens).toBeGreaterThan(0);
    expect(report.toolsTokens).toBe(5 * 160);
    expect(report.reservedOutputTokens).toBe(500);
    expect(report.totalInputTokens).toBe(
      report.systemPromptTokens + report.conversationHistoryTokens + report.toolsTokens
    );
  });
});
