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
import type { EvidenceArtifact, SkillManifest, ToolGuidance } from "@secops-agent/shared";
import type { ModelTool } from "../src/providers/types.js";
import { AgentRuntime } from "../src/runtime/agentRuntime.js";
import { MemorySessionStateStore } from "../src/runtime/sessionStateStore.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { SecOpsTool, ToolContext, ToolExecutionResult } from "../src/tools/types.js";
import { createScriptedModel } from "./fixtures/scriptedModel.js";
import { testConfig } from "./fixtures/testConfig.js";

describe("AgentRuntime", () => {
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
      maxToolRounds: 4
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

  it("ignores enabled tool filtering in full-access mode", async () => {
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
      maxToolRounds: 4
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
    expect(run.toolInvocations[0]?.toolName).toBe("case.note.write");
    expect(run.toolInvocations[0]?.status).toBe("executed");
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
      maxToolRounds: 4
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
      sessionStateStore
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
    expect(sessionStateStore.events.some((event) => event.type === "run_completed")).toBe(true);
    expect(sessionStateStore.audit.some((event) => event.type === "tool_result")).toBe(true);
  });
});

class TestTool implements SecOpsTool {
  constructor(
    readonly apiName: string,
    readonly manifest: SkillManifest,
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

function testManifest(id: string, name: string): SkillManifest {
  return {
    id,
    skillPackId: "test-pack",
    name,
    description: "Test tool.",
    toolClass: "perception",
    risk: "low",
    defaultPermission: "auto",
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

  async doStream(_options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    throw new Error("Streaming is not implemented for the two-step test model.");
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
