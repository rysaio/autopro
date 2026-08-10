import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/runtime/agentRuntime.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createScriptedModel } from "./fixtures/scriptedModel.js";

function runtimeWithBudget(maxInputTokens: number, keepRecentMessages = 10): AgentRuntime {
  return new AgentRuntime({
    model: createScriptedModel("Reply without calling a tool."),
    registry: new ToolRegistry(),
    modelName: "test-model",
    providerLabel: "test-provider",
    actionLevel: "sandbox",
    sandboxRoot: "runtime/sandbox",
    workspaceRoot: ".",
    enableLayeredRouting: false,
    contextBudget: { maxInputTokens, reservedOutputTokens: 500, keepRecentMessages }
  });
}

function longHistory(turns: number): Array<{ role: "user" | "assistant"; content: string }> {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (let index = 0; index < turns; index += 1) {
    messages.push({ role: "user", content: `investigation step ${index + 1}: ${"evidence ".repeat(40)}` });
    messages.push({ role: "assistant", content: `findings for step ${index + 1}: ${"note ".repeat(40)}` });
  }
  messages.push({ role: "user", content: "Latest request: keep investigating and summarize." });
  return messages;
}

describe("AgentRuntime context budget integration", () => {
  it("bounds a long conversation by summarizing older history while keeping investigation continuity", async () => {
    const runtime = runtimeWithBudget(2_000, 4);
    const run = await runtime.run({ messages: longHistory(15), enabledTools: [] });

    expect(run.status).toBe("completed");
    expect(run.metrics.contextBudget).toBeDefined();
    const request = run.metrics.contextBudget?.requests[0];
    expect(request).toBeDefined();
    expect(request?.withinBudget).toBe(true);
    expect(request?.summarizedMessages).toBeGreaterThan(0);
    expect(request?.systemPromptTokens).toBeGreaterThan(0);
    expect(request?.conversationHistoryTokens).toBeGreaterThan(0);
    expect(request?.toolsTokens).toBeGreaterThanOrEqual(0);
    // 调查连续性：最新用户请求保留（模型消息最后一条是最近 user 内容）
    expect(run.metrics.contextBudget?.maxInputTokens).toBe(2_000);
  });

  it("fails early with a clear actionable reason when compression cannot fit the budget", async () => {
    const runtime = runtimeWithBudget(400);
    const run = await runtime.run({
      messages: [{ role: "user", content: "huge single request ".repeat(1_000) }],
      enabledTools: []
    });

    expect(run.status).toBe("failed");
    expect(run.terminalReason).toContain("input budget");
    expect(run.terminalReason).toContain("SECOPS_CONTEXT_BUDGET_INPUT_TOKENS");
    expect(run.metrics.contextBudget?.requests[0]?.withinBudget).toBe(false);
  });

  it("keeps short conversations unchanged and still reports the budget breakdown", async () => {
    const runtime = runtimeWithBudget(64_000);
    const run = await runtime.run({
      messages: [{ role: "user", content: "Short request." }],
      enabledTools: []
    });

    expect(run.status).toBe("completed");
    expect(run.metrics.contextBudget?.requests[0]).toMatchObject({
      withinBudget: true,
      summarizedMessages: 0,
      droppedMessages: 0
    });
  });
});
