import { describe, expect, it } from "vitest";
import type { EvidenceArtifact, ToolManifest, ToolGuidance, ToolInvocation } from "@secops-agent/shared";
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

  it("caches read-only tool results and invalidates after action execution", async () => {
    const registry = new ToolRegistry();
    let executions = 0;
    registry.registerTools([
      new TestTool(
        "test_cached_read",
        testManifest("test.cached.read", "Cached Read"),
        async () => {
          executions += 1;
          return { output: { ok: true } };
        }
      )
    ]);
    const autoContext = { ...context, permissionMode: "auto" as const };

    const first = await registry.executeApiTool("test_cached_read", "cache-read-1", {}, autoContext, { useCache: true });
    const second = await registry.executeApiTool("test_cached_read", "cache-read-2", {}, autoContext, { useCache: true });

    expect(first.invocation.status).toBe("executed");
    expect(second.invocation.status).toBe("executed");
    expect(executions).toBe(1);
    expect(registry.cache.stats().hits).toBe(1);

    const action = await registry.executeApiTool("secops_case_note_write", "cache-action", {
      caseId: "INC-CACHE",
      title: "Cache invalidation note",
      body: "This action should clear read-only cache entries."
    }, autoContext);

    expect(action.invocation.status).toBe("executed");
    expect(registry.cache.stats().size).toBe(0);

    const third = await registry.executeApiTool("test_cached_read", "cache-read-3", {}, autoContext, { useCache: true });
    expect(third.invocation.status).toBe("executed");
    expect(executions).toBe(2);
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
