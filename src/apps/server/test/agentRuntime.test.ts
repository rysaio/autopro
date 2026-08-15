import { describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult
} from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import type {
  AgentRunEvent,
  AuditEvent,
  ChatMessage,
  EvidenceArtifact,
  ToolGuidance,
  ToolManifest
} from "@secops-agent/shared";
import type { ModelTool } from "../src/providers/types.js";
import { AgentRuntime } from "../src/runtime/agentRuntime.js";
import { MemorySessionStateStore } from "../src/runtime/sessionStateStore.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { SecOpsTool, ToolContext, ToolExecutionResult } from "../src/tools/types.js";
import { createScriptedModel, createScriptedReasoningModel, streamResultFromGenerateResult } from "./fixtures/scriptedModel.js";
import { testConfig } from "./fixtures/testConfig.js";

describe("AgentRuntime", () => {
  it("does not report persistence work for the disabled no-op store", async () => {
    const config = testConfig();
    const runtime = new AgentRuntime({
      model: createScriptedModel("Reply without calling a tool."),
      registry: new ToolRegistry(),
      modelName: config.model,
      providerLabel: config.provider,
      actionLevel: config.actionLevel,
      sandboxRoot: config.sandboxRoot,
      workspaceRoot: config.workspaceRoot,
      enableLayeredRouting: false
    });

    const run = await runtime.run({
      messages: [{ role: "user", content: "Reply without calling a tool." }],
      enabledTools: []
    });

    expect(run.metrics.persistence).toEqual({
      operationCount: 0,
      totalDurationMs: 0,
      failureCount: 0,
      queueWaitDurationMs: 0,
      batchWriteCount: 0,
      batchWriteDurationMs: 0,
      maxDepth: 0,
      saturationCount: 0,
      drainDurationMs: 0,
      drainTimedOut: false,
      remainingOperations: 0
    });
  });

  it("executes model-requested tools and returns audit evidence", async () => {
    const config = testConfig({
      SECOPS_ACTION_LEVEL: "sandbox"
    });
    const runtime = new AgentRuntime({
      model: createScriptedModel("Investigate suspicious IOC 198.51.100.23 for a defensive case."),
      registry: new ToolRegistry(),
      modelName: config.model,
      providerLabel: config.provider,
      actionLevel: config.actionLevel,
      sandboxRoot: config.sandboxRoot,
      workspaceRoot: config.workspaceRoot,
      maxToolRounds: 4
    });

    const run = await runtime.run({
      messages: [
        {
          role: "user",
          content: "Investigate suspicious IOC 198.51.100.23 for a defensive case."
        }
      ]
    });

    expect(run.status).toBe("completed");
    expect(run.toolInvocations).toHaveLength(1);
    expect(run.toolInvocations[0]?.toolName).toBe("ioc.enrich");
    expect(run.artifacts[0]?.kind).toBe("ioc");
    expect(run.audit.some((event) => event.type === "policy_decision")).toBe(true);
    expect(run.audit.some((event) => event.type === "tool_result")).toBe(true);
    expect(run.messages.at(-1)?.role).toBe("assistant");
    expect(run.routing.selectedToolIds).toContain("ioc.enrich");
    expect(run.routing.selectedToolIds).not.toContain("asset.inventory.lookup");
  });

  it("can perform a real sandboxed action through the SDK tool loop", async () => {
    const sandboxRoot = path.resolve("runtime/test-sandbox");
    await rm(sandboxRoot, { recursive: true, force: true });
    const config = testConfig({
      SECOPS_ACTION_LEVEL: "sandbox",
      SECOPS_SANDBOX_ROOT: sandboxRoot
    });
    const runtime = new AgentRuntime({
      model: createScriptedModel("Write note for this case note test."),
      registry: new ToolRegistry(),
      modelName: config.model,
      providerLabel: config.provider,
      actionLevel: config.actionLevel,
      sandboxRoot: config.sandboxRoot,
      workspaceRoot: config.workspaceRoot,
      maxToolRounds: 4,
      enableLayeredRouting: false
    });

    const run = await runtime.run({
      messages: [
        {
          role: "user",
          content: "Write note for this case note smoke test."
        }
      ],
      enabledTools: ["case.note.write"]
    });

    expect(run.status).toBe("completed");
    expect(run.toolInvocations[0]?.toolName).toBe("case.note.write");
    expect(run.toolInvocations[0]?.status).toBe("executed");
    expect(JSON.stringify(run.toolInvocations[0]?.result)).toContain("runtime");
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  it("keeps enabled tool filtering in full-access mode", async () => {
    const sandboxRoot = path.resolve("runtime/test-full-access-scope");
    await rm(sandboxRoot, { recursive: true, force: true });
    const config = testConfig({
      SECOPS_ACTION_LEVEL: "full-access",
      SECOPS_SANDBOX_ROOT: sandboxRoot
    });
    const runtime = new AgentRuntime({
      model: createScriptedModel("Write note for this full access scope test."),
      registry: new ToolRegistry(),
      modelName: config.model,
      providerLabel: config.provider,
      actionLevel: config.actionLevel,
      sandboxRoot: config.sandboxRoot,
      workspaceRoot: config.workspaceRoot,
      maxToolRounds: 4,
      enableLayeredRouting: false
    });

    const run = await runtime.run({
      messages: [
        {
          role: "user",
          content: "Write note for this full access scope test."
        }
      ],
      enabledTools: ["ioc.enrich"],
      permissionMode: "deny"
    });

    expect(run.status).toBe("completed");
    expect(run.toolInvocations).toEqual([]);
    expect(run.routing.selectedToolIds).toEqual([]);
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  it("returns recoverable guidance to the model and audit trail", async () => {
    const config = testConfig({
      SECOPS_ACTION_LEVEL: "sandbox"
    });
    const guidance: ToolGuidance = {
      kind: "precondition",
      message: "Call prep.lookup before action.execute.",
      nextTools: [
        {
          toolName: "prep.lookup",
          reason: "Collect required state before execution.",
          suggestedArgs: { id: "target-1" }
        }
      ],
      requiredState: ["prep.ready:target-1"],
      recoverable: true
    };
    const registry = new ToolRegistry([
      new TestTool(
        "test_guided_action",
        testManifest("test.guided.action", "Guided Action"),
        async () => ({
          output: {
            status: "needs_precondition",
            guidance
          }
        })
      )
    ]);
    const runtime = new AgentRuntime({
      model: createScriptedModel("Trigger guidance flow."),
      registry,
      modelName: config.model,
      providerLabel: config.provider,
      actionLevel: config.actionLevel,
      sandboxRoot: config.sandboxRoot,
      workspaceRoot: config.workspaceRoot,
      maxToolRounds: 4,
      enableLayeredRouting: false
    });
    const events: string[] = [];

    const run = await runtime.run({
      messages: [
        {
          role: "user",
          content: "Trigger guidance flow."
        }
      ]
    }, (event) => {
      events.push(JSON.stringify(event));
    });

    expect(run.status).toBe("completed");
    expect(run.toolInvocations[0]).toMatchObject({
      status: "failed",
      guidance
    });
    expect(run.messages.some((message) => message.role === "tool" && message.content.includes("needs_precondition"))).toBe(true);
    expect(run.audit.some((event) => event.type === "tool_result" && event.detail.includes("recoverable guidance"))).toBe(true);
    expect(events.some((event) => event.includes("needs_precondition"))).toBe(true);
  });

  it("records run state and carries tool state markers into later tool calls", async () => {
    const config = testConfig({
      SECOPS_ACTION_LEVEL: "sandbox"
    });
    const sessionStateStore = new MemorySessionStateStore();
    let observedMarkers: string[] | undefined;
    const artifact: EvidenceArtifact = {
      id: "artifact-marker",
      title: "Marker artifact",
      kind: "runtime",
      summary: "A state marker was produced.",
      data: { stateMarkers: ["state.ready:target-1"] },
      createdAt: new Date().toISOString()
    };
    const registry = new ToolRegistry([
      new TestTool("test_state_prepare", testManifest("test.state.prepare", "Prepare State"), async () => ({
        output: {
          stateMarkers: ["state.ready:target-1"],
          prepared: true
        },
        artifacts: [artifact]
      })),
      new TestTool("test_state_consume", testManifest("test.state.consume", "Consume State"), async (_args, context) => {
        observedMarkers = context.stateMarkers;
        return {
          output: {
            sawMarker: context.stateMarkers?.includes("state.ready:target-1") ?? false
          }
        };
      })
    ]);
    const runtime = new AgentRuntime({
      model: createTwoStepToolModel(["test_state_prepare", "test_state_consume"]),
      registry,
      modelName: config.model,
      providerLabel: config.provider,
      actionLevel: config.actionLevel,
      sandboxRoot: config.sandboxRoot,
      workspaceRoot: config.workspaceRoot,
      maxToolRounds: 4,
      sessionStateStore,
      enableLayeredRouting: false
    });

    const run = await runtime.run({
      sessionId: "session-state-test",
      messages: [
        {
          role: "user",
          content: "Prepare then consume state."
        }
      ]
    });

    expect(run.status).toBe("completed");
    expect(run.toolInvocations.map((invocation) => invocation.toolName)).toEqual(["test.state.prepare", "test.state.consume"]);
    expect(run.toolInvocations[1]?.result).toMatchObject({ sawMarker: true });
    expect(observedMarkers).toContain("state.ready:target-1");
    expect(sessionStateStore.runs).toHaveLength(1);
    expect(sessionStateStore.runs[0]).toMatchObject({
      sessionId: "session-state-test",
      runId: run.id,
      completed: {
        id: run.id
      }
    });
    expect(sessionStateStore.messages.length).toBeGreaterThanOrEqual(3);
    expect(sessionStateStore.invocations).toHaveLength(2);
    expect(sessionStateStore.artifacts).toEqual([artifact]);
    expect(sessionStateStore.markers).toMatchObject([
      {
        sessionId: "session-state-test",
        runId: run.id,
        key: "state.ready:target-1",
        value: {
          toolName: "test.state.prepare"
        }
      }
    ]);
    const completionEvent = sessionStateStore.events.find((event) => event.type === "run_completed");
    expect(completionEvent?.run?.metrics).toEqual(run.metrics);
    expect(sessionStateStore.runs[0]?.completed?.metrics).toEqual(run.metrics);
    expect(sessionStateStore.audit.some((event) => event.type === "tool_result")).toBe(true);
  });

  it("counts business writes without counting the state-marker recovery read", async () => {
    const config = testConfig();
    const sessionStateStore = new MemorySessionStateStore();
    const runtime = new AgentRuntime({
      model: createScriptedModel("Reply without calling a tool."),
      registry: new ToolRegistry(),
      modelName: config.model,
      providerLabel: config.provider,
      actionLevel: config.actionLevel,
      sandboxRoot: config.sandboxRoot,
      workspaceRoot: config.workspaceRoot,
      sessionStateStore,
      enableLayeredRouting: false
    });

    const run = await runtime.run({
      messages: [{ role: "user", content: "Reply without calling a tool." }],
      enabledTools: []
    });
    const recordedEvents = sessionStateStore.events.filter((event) => event.type !== "run_completed").length;
    const completedBusinessWrites = 1
      + sessionStateStore.messages.length
      + sessionStateStore.audit.length
      + recordedEvents;

    expect(run.metrics.persistence.operationCount).toBe(completedBusinessWrites);
    expect(run.metrics.persistence.failureCount).toBe(0);
  });

  it("exports queued business-write failures in the terminal snapshot", async () => {
    const config = testConfig();
    const sessionStateStore = new FailOnceMemorySessionStateStore();
    const runtime = new AgentRuntime({
      model: createScriptedModel("Reply without calling a tool."),
      registry: new ToolRegistry(),
      modelName: config.model,
      providerLabel: config.provider,
      actionLevel: config.actionLevel,
      sandboxRoot: config.sandboxRoot,
      workspaceRoot: config.workspaceRoot,
      sessionStateStore,
      enableLayeredRouting: false
    });

    const run = await runtime.run({
      messages: [{ role: "user", content: "Reply without calling a tool." }],
      enabledTools: []
    });

    expect(run.status).toBe("failed");
    expect(run.metrics.persistence.failureCount).toBe(1);
    expect(run.audit).toContainEqual(expect.objectContaining({
      label: "Persistence error",
      severity: "error"
    }));
    expect(sessionStateStore.events.find((event) => event.type === "run_completed")?.run?.metrics).toEqual(run.metrics);
  });

  it("persists run events in order through the bounded async queue (Issue #10)", async () => {
    const config = testConfig();
    const store = new RecordingSessionStateStore();
    const runtime = new AgentRuntime({
      model: createScriptedModel("Reply without calling a tool."),
      registry: new ToolRegistry(),
      modelName: config.model,
      providerLabel: config.provider,
      actionLevel: config.actionLevel,
      sandboxRoot: config.sandboxRoot,
      workspaceRoot: config.workspaceRoot,
      sessionStateStore: store,
      enableLayeredRouting: false
    });

    const run = await runtime.run({
      messages: [{ role: "user", content: "Reply without calling a tool." }],
      enabledTools: []
    });

    expect(run.status).toBe("completed");
    // 入队顺序与存储写入顺序一致：消息 → run_started → 路由审计 → 审计事件 →
    // 请求审计 → 审计事件 → 助手消息 → 消息事件 → 响应审计 → 审计事件
    expect(store.callOrder).toEqual([
      "message:user",
      "event:run_started",
      "audit:routing_decision",
      "event:audit",
      "audit:model_request",
      "event:audit",
      "message:assistant",
      "event:message",
      "audit:model_response",
      "event:audit"
    ]);
  });

  it("reports bounded-queue metrics in the terminal snapshot (Issue #10)", async () => {
    const config = testConfig();
    const store = new RecordingSessionStateStore();
    const runtime = new AgentRuntime({
      model: createScriptedModel("Reply without calling a tool."),
      registry: new ToolRegistry(),
      modelName: config.model,
      providerLabel: config.provider,
      actionLevel: config.actionLevel,
      sandboxRoot: config.sandboxRoot,
      workspaceRoot: config.workspaceRoot,
      sessionStateStore: store,
      enableLayeredRouting: false
    });

    const run = await runtime.run({
      messages: [{ role: "user", content: "Reply without calling a tool." }],
      enabledTools: []
    });

    const persistence = run.metrics.persistence;
    expect(persistence.drainTimedOut).toBe(false);
    expect(persistence.remainingOperations).toBe(0);
    expect(persistence.batchWriteCount).toBeGreaterThanOrEqual(1);
    expect(persistence.maxDepth).toBeGreaterThanOrEqual(1);
    expect(persistence.queueWaitDurationMs).toBeGreaterThanOrEqual(0);
    expect(persistence.saturationCount).toBe(0);
    expect(persistence.operationCount).toBe(store.callOrder.length + 1);
  });

  it("emits partial text and a cancelled terminal snapshot when the caller aborts", async () => {
    const config = testConfig();
    const runtime = new AgentRuntime({
      model: new BlockingTextModel(),
      registry: new ToolRegistry(),
      modelName: config.model,
      providerLabel: config.provider,
      actionLevel: config.actionLevel,
      sandboxRoot: config.sandboxRoot,
      workspaceRoot: config.workspaceRoot,
      enableLayeredRouting: false
    });
    const controller = new AbortController();
    const events: AgentRunEvent[] = [];

    const run = await runtime.run({
      messages: [{ role: "user", content: "Start a long investigation." }],
      enabledTools: []
    }, (event) => {
      events.push(event);
      if (event.type === "text_delta") {
        controller.abort({ status: "cancelled", message: "Cancelled by test analyst." });
      }
    }, { signal: controller.signal });

    const delta = events.find((event) => event.type === "text_delta");
    const finalMessage = events.find((event) => event.type === "message" && event.message.role === "assistant");
    expect(run.status).toBe("cancelled");
    expect(run.terminalReason).toBe("Cancelled by test analyst.");
    expect(run.audit).toContainEqual(expect.objectContaining({ label: "Run cancelled", severity: "warn" }));
    expect(finalMessage?.message.id).toBe(delta?.messageId);
    expect(finalMessage?.message.content).toContain("Partial evidence");
    expect(events.at(-1)?.type).toBe("run_completed");
  });

  it("records a timed_out terminal state when the run deadline elapses", async () => {
    const config = testConfig();
    const runtime = new AgentRuntime({
      model: new BlockingTextModel(),
      registry: new ToolRegistry(),
      modelName: config.model,
      providerLabel: config.provider,
      actionLevel: config.actionLevel,
      sandboxRoot: config.sandboxRoot,
      workspaceRoot: config.workspaceRoot,
      enableLayeredRouting: false,
      runTimeoutMs: 20
    });

    const run = await runtime.run({
      messages: [{ role: "user", content: "Start a slow investigation." }],
      enabledTools: []
    });

    expect(run.status).toBe("timed_out");
    expect(run.terminalReason).toContain("20 ms");
    expect(run.audit).toContainEqual(expect.objectContaining({ label: "Run timed out", severity: "error" }));
  });

  it("propagates the run abort signal through an active tool boundary", async () => {
    const config = testConfig();
    let receivedSignal = false;
    let observedAbort = false;
    const registry = new ToolRegistry([
      new TestTool("test_blocking_tool", testManifest("test.blocking", "Blocking Tool"), async (_args, context) => {
        receivedSignal = Boolean(context.signal);
        return new Promise((_resolve, reject) => {
          context.signal?.addEventListener("abort", () => {
            observedAbort = true;
            reject(context.signal?.reason);
          }, { once: true });
        });
      })
    ]);
    const runtime = new AgentRuntime({
      model: createScriptedModel("Call the blocking tool."),
      registry,
      modelName: config.model,
      providerLabel: config.provider,
      actionLevel: config.actionLevel,
      sandboxRoot: config.sandboxRoot,
      workspaceRoot: config.workspaceRoot,
      enableLayeredRouting: false,
      runTimeoutMs: 20
    });

    const run = await runtime.run({
      messages: [{ role: "user", content: "Call the blocking tool." }],
      enabledTools: ["test.blocking"]
    });

    expect(run.status).toBe("timed_out");
    expect(receivedSignal).toBe(true);
    expect(observedAbort).toBe(true);
  });

  it("streams model reasoning as ordered thinking messages before the final text", async () => {
    const config = testConfig();
    const events: AgentRunEvent[] = [];
    const reasoningText = "I will first check the available evidence, then decide whether any side-effecting action is warranted.";
    const runtime = new AgentRuntime({
      model: createScriptedReasoningModel("Reply without calling a tool."),
      registry: new ToolRegistry(),
      modelName: config.model,
      providerLabel: config.provider,
      actionLevel: config.actionLevel,
      sandboxRoot: config.sandboxRoot,
      workspaceRoot: config.workspaceRoot,
      enableLayeredRouting: false
    });

    const run = await runtime.run({
      messages: [{ role: "user", content: "Reply without calling a tool." }],
      enabledTools: []
    }, (event) => events.push(event));

    // 完整 thinking 消息以 name="thinking" 落入会话消息，内容与模型 reasoning 一致
    const thinkingMessages = run.messages.filter((message) => message.name === "thinking");
    expect(thinkingMessages).toHaveLength(1);
    expect(thinkingMessages[0]?.content).toBe(reasoningText);

    // 顺序：thinking 消息先于最终 assistant 文本消息（与模型实际输出顺序一致）
    const finalTextMessage = run.messages.find((message) => message.role === "assistant" && message.name !== "thinking");
    expect(finalTextMessage).toBeDefined();
    const thinkingIndex = run.messages.findIndex((message) => message.id === thinkingMessages[0]?.id);
    const textIndex = run.messages.findIndex((message) => message.id === finalTextMessage?.id);
    expect(thinkingIndex).toBeLessThan(textIndex);

    // 事件流：节流快照（streaming: true）先推送，最终完整 thinking 消息后落库
    const snapshotEvents = events.filter((event) => event.type === "message" && event.streaming);
    expect(snapshotEvents.length).toBeGreaterThanOrEqual(1);
    const finalThinkingEvent = events.find((event) =>
      event.type === "message" && !event.streaming && event.message?.name === "thinking"
    );
    expect(finalThinkingEvent).toBeDefined();
    expect(events.indexOf(snapshotEvents[0] as AgentRunEvent)).toBeLessThan(
      events.indexOf(finalThinkingEvent as AgentRunEvent)
    );
    expect((finalThinkingEvent as { message: ChatMessage }).message.content).toBe(reasoningText);
  });
});

class FailOnceMemorySessionStateStore extends MemorySessionStateStore {
  private shouldFail = true;

  override async appendMessage(sessionId: string, runId: string, message: ChatMessage): Promise<void> {
    if (this.shouldFail) {
      this.shouldFail = false;
      throw new Error("simulated business-write failure");
    }
    await super.appendMessage(sessionId, runId, message);
  }
}

/** 记录存储写入顺序，用于验证有界队列的 run 内事件顺序（Issue #10）。 */
class RecordingSessionStateStore extends MemorySessionStateStore {
  readonly callOrder: string[] = [];

  override async recordRunEvent(event: AgentRunEvent): Promise<void> {
    this.callOrder.push(`event:${event.type}`);
    await super.recordRunEvent(event);
  }

  override async recordAuditEvent(sessionId: string, runId: string, audit: AuditEvent): Promise<void> {
    this.callOrder.push(`audit:${audit.type}`);
    await super.recordAuditEvent(sessionId, runId, audit);
  }

  override async appendMessage(sessionId: string, runId: string, message: ChatMessage): Promise<void> {
    this.callOrder.push(`message:${message.role}`);
    await super.appendMessage(sessionId, runId, message);
  }
}

class BlockingTextModel implements LanguageModelV3 {
  readonly specificationVersion = "v3";
  readonly provider = "test-provider";
  readonly modelId = "blocking-text-model";
  readonly supportedUrls = {};

  async doGenerate(_options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    throw new Error("BlockingTextModel only supports streaming");
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    return {
      stream: new ReadableStream({
        start(controller) {
          const textId = "blocking-text";
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: textId });
          controller.enqueue({ type: "text-delta", id: textId, delta: "Partial evidence" });
          const abort = () => controller.error(options.abortSignal?.reason ?? new Error("aborted"));
          if (options.abortSignal?.aborted) {
            abort();
          } else {
            options.abortSignal?.addEventListener("abort", abort, { once: true });
          }
        }
      })
    };
  }
}

class TestTool implements SecOpsTool {
  constructor(
    readonly apiName: string,
    readonly manifest: ToolManifest,
    private readonly handler: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolExecutionResult>
  ) {}

  toModelTool(): ModelTool {
    return {
      type: "function",
      function: {
        name: this.apiName,
        description: this.manifest.description,
        parameters: this.manifest.inputSchema
      }
    };
  }

  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    return this.handler(args, context);
  }
}

function testManifest(id: string, name: string): ToolManifest {
  return {
    id,
    name,
    description: "Test tool.",
    toolClass: "perception",
    risk: "low",
    deferLoading: false,
    tags: ["test"],
    mcpCompatible: true,
    inputSchema: {
      type: "object",
      properties: {
        indicator: { type: "string" }
      },
      required: [],
      additionalProperties: false
    }
  };
}

function createTwoStepToolModel(toolNames: [string, string]): LanguageModel {
  return new TwoStepToolModel(toolNames);
}

class TwoStepToolModel implements LanguageModelV3 {
  readonly specificationVersion = "v3";
  readonly provider = "test-provider";
  readonly modelId = "two-step-test-model";
  readonly supportedUrls = {};
  private step = 0;

  constructor(private readonly toolNames: [string, string]) {}

  async doGenerate(_options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    this.step += 1;
    if (this.step <= this.toolNames.length) {
      return {
        content: [
          {
            type: "tool-call",
            toolCallId: `call_${this.step}`,
            toolName: this.toolNames[this.step - 1],
            input: "{}"
          }
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: usage(),
        warnings: []
      };
    }
    return {
      content: [
        {
          type: "text",
          text: "State marker flow completed."
        }
      ],
      finishReason: { unified: "stop", raw: "stop" },
      usage: usage(),
      warnings: []
    };
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    return streamResultFromGenerateResult(await this.doGenerate(options));
  }
}

function usage() {
  return {
    inputTokens: {
      total: 20,
      noCache: 20,
      cacheRead: undefined,
      cacheWrite: undefined
    },
    outputTokens: {
      total: 10,
      text: 10,
      reasoning: undefined
    }
  };
}
