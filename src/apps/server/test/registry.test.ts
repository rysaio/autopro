import { describe, expect, it } from "vitest";
import type { EvidenceArtifact, ToolManifest, ToolGuidance, ToolInvocation } from "@secops-agent/shared";
import { ToolCache } from "../src/runtime/toolCache.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ModelTool } from "../src/providers/types.js";
import type { SecOpsTool, ToolContext, ToolExecutionResult } from "../src/tools/types.js";

const context = {
  runId: "registry-test",
  permissionMode: "ask" as const,
  actionLevel: "sandbox" as const,
  sandboxRoot: "runtime/registry-test-sandbox",
  workspaceRoot: "."
};

describe("ToolRegistry", () => {
  it("applies and clears deferLoading overrides without mutating declarations", () => {
    const registry = new ToolRegistry();

    expect(registry.manifests().find((manifest) => manifest.id === "report.generate")?.deferLoading).toBe(true);
    expect(registry.setDeferLoadingOverride("report.generate", false)).toBe(true);
    expect(registry.manifests().find((manifest) => manifest.id === "report.generate")?.deferLoading).toBe(false);

    expect(registry.clearDeferLoadingOverride("report.generate")).toBe(true);
    expect(registry.manifests().find((manifest) => manifest.id === "report.generate")?.deferLoading).toBe(true);
    expect(registry.clearDeferLoadingOverride("report.generate")).toBe(false);
    expect(registry.setDeferLoadingOverride("missing.tool", false)).toBe(false);
    expect(registry.clearDeferLoadingOverride("missing.tool")).toBe(false);
  });

  it("exposes MCP-compatible skill manifests with action tools gated by risk", () => {
    const registry = new ToolRegistry();
    const manifests = registry.manifests();

    expect(manifests).toHaveLength(14);
    expect(new Set(manifests.map((manifest) => manifest.id)).size).toBe(manifests.length);
    expect(manifests.every((manifest) => manifest.mcpCompatible)).toBe(true);
    expect(manifests.filter((manifest) => manifest.toolClass === "action")).toHaveLength(5);
    expect(manifests.find((manifest) => manifest.id === "full_access.exec")?.risk).toBe("high");
  });

  it("registers and removes external plugin tools dynamically", () => {
    const registry = new ToolRegistry();
    const external = new TestTool(
      "test_external_tool",
      testManifest("external.hello", "External Hello"),
      async () => ({ output: { ok: true } })
    );

    registry.registerTools([external]);
    expect(registry.manifests()).toHaveLength(15);
    expect(registry.manifests().find((manifest) => manifest.id === "external.hello")).toMatchObject({
      id: "external.hello",
      name: "External Hello"
    });

    registry.unregisterExternalTools();
    expect(registry.manifests()).toHaveLength(14);
    expect(registry.manifests().find((manifest) => manifest.id === "external.hello")).toBeUndefined();
  });

  it("fails invalid tool arguments before policy and approval persistence", async () => {
    const registry = new ToolRegistry();

    const record = await registry.executeApiTool(
      "secops_case_note_write",
      "invalid-note-call",
      {
        caseId: "INC-VALIDATION",
        title: "Missing body"
      },
      context
    );

    expect(record.invocation.status).toBe("failed");
    expect(record.invocation.error).toContain("Missing required argument");
    await expect(registry.pendingApprovals()).resolves.toHaveLength(0);
  });

  it("rejects unexpected properties and invalid enum values at the registry boundary", async () => {
    const registry = new ToolRegistry();

    const unexpected = await registry.executeApiTool(
      "secops_ioc_enrich",
      "extra-arg-call",
      {
        indicator: "198.51.100.23",
        unexpected: true
      },
      context
    );
    expect(unexpected.invocation.status).toBe("failed");
    expect(unexpected.invocation.error).toContain("Unexpected argument");

    const invalidEnum = await registry.executeApiTool(
      "secops_command_run_sandbox",
      "bad-command-call",
      {
        commandId: "whoami"
      },
      {
        ...context,
        permissionMode: "auto"
      }
    );
    expect(invalidEnum.invocation.status).toBe("failed");
    expect(invalidEnum.invocation.error).toContain("Invalid value");
  });

  it("supports typed recoverable guidance on tool invocations", () => {
    const guidance: ToolGuidance = {
      kind: "precondition",
      message: "Call shuffle.workflow.get before shuffle.workflow.execute.",
      nextTools: [
        {
          toolName: "shuffle.workflow.get",
          reason: "Fetch workflow metadata before execution.",
          suggestedArgs: { workflowId: "wf-123" }
        }
      ],
      requiredState: ["shuffle.workflow.metadata:wf-123"],
      recoverable: true
    };
    const invocation: ToolInvocation = {
      id: "guided-call",
      toolName: "shuffle.workflow.execute",
      displayName: "Execute Shuffle Workflow",
      status: "failed",
      risk: "high",
      arguments: { workflowId: "wf-123" },
      result: {
        status: "needs_precondition",
        guidance
      },
      guidance,
      startedAt: new Date().toISOString()
    };

    expect(invocation.guidance?.recoverable).toBe(true);
    expect(invocation.result).toMatchObject({
      status: "needs_precondition",
      guidance: {
        kind: "precondition",
        nextTools: [
          {
            toolName: "shuffle.workflow.get"
          }
        ]
      }
    });
  });

  it("maps recoverable tool guidance to a compatible failed invocation", async () => {
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
    const artifact: EvidenceArtifact = {
      id: "artifact-guidance",
      title: "Guidance artifact",
      kind: "runtime",
      summary: "Recoverable guidance was produced.",
      data: { guidance },
      createdAt: new Date().toISOString()
    };
    const registry = new ToolRegistry([
      new TestTool(
        "test_guided_action",
        testManifest("test.guided.action", "Guided Action"),
        async () => ({
          output: {
            status: "needs_precondition",
            guidance
          },
          artifacts: [artifact]
        })
      )
    ]);

    const record = await registry.executeApiTool("test_guided_action", "guided-call", {}, {
      ...context,
      permissionMode: "auto"
    });

    expect(record.invocation.status).toBe("failed");
    expect(record.invocation.error).toBe("Recoverable tool guidance returned");
    expect(record.invocation.guidance).toEqual(guidance);
    expect(record.invocation.result).toEqual({
      status: "needs_precondition",
      guidance
    });
    expect(record.artifacts).toEqual([artifact]);
  });

  it("requires approval for all action tools under ask mode (no tool-declared exception)", async () => {
    const registry = new ToolRegistry();
    registry.registerTools([
      new TestTool(
        "test_high_risk_action",
        { ...testManifest("test.high.risk.action", "High Risk Action"), toolClass: "action", risk: "high" },
        async () => ({ output: { ok: true } })
      ),
      new TestTool(
        "test_low_risk_action",
        { ...testManifest("test.low.risk.action", "Low Risk Action"), toolClass: "action", risk: "low" },
        async () => ({ output: { ok: true } })
      )
    ]);

    const high = await registry.executeApiTool("test_high_risk_action", "ask-high", {}, context);
    const low = await registry.executeApiTool("test_low_risk_action", "ask-low", {}, context);
    const note = await registry.executeApiTool("secops_case_note_write", "ask-note", {
      caseId: "INC-ASK",
      title: "Note",
      body: "Body"
    }, context);

    expect(high.invocation.status).toBe("pending_approval");
    expect(low.invocation.status).toBe("pending_approval");
    expect(note.invocation.status).toBe("pending_approval");
    expect(high.invocation.error).toContain("requires explicit analyst approval");
  });

  it("auto mode approves high risk by default but executes medium/low risk actions", async () => {
    const registry = new ToolRegistry();
    registry.registerTools([
      new TestTool(
        "test_high_risk_action",
        { ...testManifest("test.high.risk.action", "High Risk Action"), toolClass: "action", risk: "high" },
        async () => ({ output: { ok: true } })
      ),
      new TestTool(
        "test_low_risk_action",
        { ...testManifest("test.low.risk.action", "Low Risk Action"), toolClass: "action", risk: "low" },
        async () => ({ output: { ok: true } })
      ),
      new TestTool(
        "test_read_tool",
        testManifest("test.read.tool", "Read Tool"),
        async () => ({ output: { ok: true } })
      )
    ]);
    const autoContext = { ...context, permissionMode: "auto" as const };

    const high = await registry.executeApiTool("test_high_risk_action", "auto-high", {}, autoContext);
    const low = await registry.executeApiTool("test_low_risk_action", "auto-low", {}, autoContext);
    const note = await registry.executeApiTool("secops_case_note_write", "auto-note", {
      caseId: "INC-AUTO",
      title: "Note",
      body: "Body"
    }, autoContext);
    const read = await registry.executeApiTool("test_read_tool", "auto-read", {}, autoContext);

    expect(high.invocation.status).toBe("pending_approval");
    expect(high.invocation.error).toContain("High risk action tool requires approval under auto mode policy");
    expect(low.invocation.status).toBe("executed");
    expect(note.invocation.status).toBe("executed");
    expect(read.invocation.status).toBe("executed");
  });

  it("autoApproveHighRisk=false executes high risk actions fully automatically", async () => {
    const registry = new ToolRegistry(undefined, undefined, false);
    registry.registerTools([
      new TestTool(
        "test_high_risk_action",
        { ...testManifest("test.high.risk.action", "High Risk Action"), toolClass: "action", risk: "high" },
        async () => ({ output: { ok: true } })
      )
    ]);
    const autoContext = { ...context, permissionMode: "auto" as const };

    const high = await registry.executeApiTool("test_high_risk_action", "auto-high", {}, autoContext);
    const note = await registry.executeApiTool("secops_case_note_write", "auto-note", {
      caseId: "INC-AUTO",
      title: "Note",
      body: "Body"
    }, autoContext);

    expect(high.invocation.status).toBe("executed");
    expect(note.invocation.status).toBe("executed");
  });

  it("deny mode allows non-action tools but denies action tools", async () => {
    const registry = new ToolRegistry();
    registry.registerTools([
      new TestTool(
        "test_action_tool",
        { ...testManifest("test.action.tool", "Action Tool"), toolClass: "action", risk: "medium" },
        async () => ({ output: { ok: true } })
      ),
      new TestTool(
        "test_read_tool",
        testManifest("test.read.tool", "Read Tool"),
        async () => ({ output: { ok: true } })
      )
    ]);
    const denyContext = { ...context, permissionMode: "deny" as const };

    const action = await registry.executeApiTool("test_action_tool", "deny-action", {}, denyContext);
    const read = await registry.executeApiTool("test_read_tool", "deny-read", {}, denyContext);

    expect(action.invocation.status).toBe("denied");
    expect(action.invocation.error).toContain("Action tool execution denied by permission policy");
    expect(read.invocation.status).toBe("executed");
  });

  it("deny mode rejects even previously approved action replays (read-only contract)", async () => {
    const registry = new ToolRegistry();
    registry.registerTools([
      new TestTool(
        "test_action_tool",
        { ...testManifest("test.action.tool", "Action Tool"), toolClass: "action", risk: "medium" },
        async () => ({ output: { ok: true } })
      )
    ]);
    const denyReplayContext = {
      ...context,
      permissionMode: "deny" as const,
      approvedToolCallIds: ["deny-replay"]
    };

    const action = await registry.executeApiTool("test_action_tool", "deny-replay", {}, denyReplayContext);

    expect(action.invocation.status).toBe("denied");
    expect(action.invocation.error).toContain("Action tool execution denied by permission policy");
  });

  it("opts in only the approved built-in threat intelligence lookup", () => {
    const policies = new ToolRegistry().manifests()
      .filter((manifest) => manifest.resultCache)
      .map((manifest) => [manifest.id, manifest.resultCache]);

    expect(policies).toEqual([[
      "threat.intel.lookup",
      {
        version: "1",
        dataSource: "built-in-threat-intel-kb-v1",
        ttlMs: 5 * 60 * 1000
      }
    ]]);
  });

  it("reuses an approved read-only result across runs with fresh audit identities", async () => {
    let handlerCalls = 0;
    const artifact: EvidenceArtifact = {
      id: "original-artifact",
      title: "Cached evidence",
      kind: "ioc",
      summary: "Evidence summary",
      data: { nested: { value: true } },
      createdAt: "2026-08-09T00:00:00.000Z"
    };
    const registry = new ToolRegistry([
      new TestTool("test_cached_lookup", cacheableManifest(), async () => {
        handlerCalls += 1;
        return { output: { handlerCalls }, artifacts: [artifact] };
      })
    ]);

    const first = await registry.executeApiTool(
      "test_cached_lookup",
      "call-one",
      { query: { b: 2, a: 1 }, values: ["one", "two"] },
      { ...context, runId: "run-one" }
    );
    const second = await registry.executeApiTool(
      "test_cached_lookup",
      "call-two",
      { values: ["one", "two"], query: { a: 1, b: 2 } },
      { ...context, runId: "run-two" }
    );

    expect(handlerCalls).toBe(1);
    expect(first.invocation.cache).toEqual({ status: "miss" });
    expect(second.invocation).toMatchObject({
      id: "call-two",
      result: { handlerCalls: 1 },
      cache: {
        status: "hit",
        sourceInvocationId: "call-one",
        originalCreatedAt: expect.any(String),
        ageMs: expect.any(Number),
        avoidedToolDurationMs: expect.any(Number)
      }
    });
    expect(second.artifacts[0]?.id).not.toBe(first.artifacts[0]?.id);
    expect(second.artifacts[0]?.cacheSource).toEqual({
      artifactId: "original-artifact",
      originalCreatedAt: artifact.createdAt,
      ageMs: expect.any(Number)
    });
    expect(second.artifacts[0]?.data).toEqual(first.artifacts[0]?.data);
  });

  it("executes again for different arguments, TTL expiry, and a new service cache", async () => {
    let now = 1_000;
    let handlerCalls = 0;
    const tool = new TestTool("test_cached_lookup", cacheableManifest(50), async () => {
      handlerCalls += 1;
      return { output: { handlerCalls } };
    });
    const firstRegistry = new ToolRegistry([tool], undefined, true, new ToolCache({ now: () => now }));

    await firstRegistry.executeApiTool("test_cached_lookup", "one", { query: "alpha" }, context);
    await firstRegistry.executeApiTool("test_cached_lookup", "two", { query: "beta" }, context);
    now = 1_050;
    await firstRegistry.executeApiTool("test_cached_lookup", "three", { query: "alpha" }, context);
    const restartedRegistry = new ToolRegistry([tool], undefined, true, new ToolCache({ now: () => now }));
    await restartedRegistry.executeApiTool("test_cached_lookup", "four", { query: "alpha" }, context);

    expect(handlerCalls).toBe(4);
    expect(firstRegistry.cacheStats()).toMatchObject({ expiredEntries: 2 });
  });

  it("does not cache failures or recoverable guidance", async () => {
    let failedCalls = 0;
    let guidedCalls = 0;
    const guidance: ToolGuidance = {
      kind: "precondition",
      message: "Collect context first.",
      recoverable: true
    };
    const registry = new ToolRegistry([
      new TestTool("test_cached_failure", cacheableManifest(1_000, "test.cached.failure"), async () => {
        failedCalls += 1;
        throw new Error("upstream failed");
      }),
      new TestTool("test_cached_guidance", cacheableManifest(1_000, "test.cached.guidance"), async () => {
        guidedCalls += 1;
        return { output: { status: "needs_precondition", guidance } };
      })
    ]);

    const failures = await Promise.all([
      registry.executeApiTool("test_cached_failure", "failed-one", { query: "same" }, context),
      registry.executeApiTool("test_cached_failure", "failed-two", { query: "same" }, context)
    ]);
    const guided = await Promise.all([
      registry.executeApiTool("test_cached_guidance", "guided-one", { query: "same" }, context),
      registry.executeApiTool("test_cached_guidance", "guided-two", { query: "same" }, context)
    ]);

    expect(failedCalls).toBe(2);
    expect(guidedCalls).toBe(2);
    expect(failures.every((record) => record.invocation.cache?.status === "bypass")).toBe(true);
    expect(guided.every((record) => record.invocation.cache?.status === "bypass")).toBe(true);
    expect(registry.cacheStats().size).toBe(0);
  });

  it("never caches actions and globally invalidates read results after success", async () => {
    let readCalls = 0;
    let actionCalls = 0;
    const readTool = new TestTool("test_cached_lookup", cacheableManifest(), async () => {
      readCalls += 1;
      return { output: { readCalls } };
    });
    const actionTool = new TestTool(
      "test_cached_action",
      { ...cacheableManifest(), id: "test.cached.action", toolClass: "action", risk: "medium" },
      async () => {
        actionCalls += 1;
        return { output: { actionCalls } };
      }
    );
    const registry = new ToolRegistry([readTool, actionTool]);
    const autoContext = { ...context, permissionMode: "auto" as const };

    await registry.executeApiTool("test_cached_lookup", "read-one", { query: "same" }, context);
    await registry.executeApiTool("test_cached_lookup", "read-two", { query: "same" }, context);
    const firstAction = await registry.executeApiTool("test_cached_action", "action-one", { query: "same" }, autoContext);
    const secondAction = await registry.executeApiTool("test_cached_action", "action-two", { query: "same" }, autoContext);
    await registry.executeApiTool("test_cached_lookup", "read-three", { query: "same" }, context);

    expect(readCalls).toBe(2);
    expect(actionCalls).toBe(2);
    expect(firstAction.invocation.cache).toEqual({ status: "bypass", reason: "action" });
    expect(secondAction.invocation.cache).toEqual({ status: "bypass", reason: "action" });
    expect(firstAction.metrics.invalidatedEntries).toBe(1);
  });

  it("checks action approval before any cache access", async () => {
    let handlerCalls = 0;
    const action = new TestTool(
      "test_cached_action",
      { ...cacheableManifest(), id: "test.cached.action", toolClass: "action", risk: "medium" },
      async () => {
        handlerCalls += 1;
        return { output: { ok: true } };
      }
    );
    const registry = new ToolRegistry([action]);

    const pending = await registry.executeApiTool("test_cached_action", "pending", { query: "same" }, context);
    const denied = await registry.executeApiTool(
      "test_cached_action",
      "denied",
      { query: "same" },
      { ...context, permissionMode: "deny" }
    );

    expect(pending.invocation).toMatchObject({ status: "pending_approval", cache: { status: "bypass" } });
    expect(denied.invocation).toMatchObject({ status: "denied", cache: { status: "bypass" } });
    expect(handlerCalls).toBe(0);
    expect(registry.cacheStats()).toMatchObject({ hits: 0, misses: 0, size: 0 });
  });
});

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
      properties: {},
      required: [],
      additionalProperties: false
    }
  };
}

function cacheableManifest(ttlMs = 1_000, id = "test.cached.lookup"): ToolManifest {
  return {
    ...testManifest(id, "Cached Lookup"),
    resultCache: {
      version: "1",
      dataSource: "test-source",
      ttlMs
    },
    inputSchema: {
      type: "object",
      properties: {
        query: {},
        values: { type: "array" }
      },
      additionalProperties: false
    }
  };
}
