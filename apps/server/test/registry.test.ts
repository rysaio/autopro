import { describe, expect, it } from "vitest";
import type { EvidenceArtifact, SkillManifest, ToolGuidance, ToolInvocation } from "@secops-agent/shared";
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
  it("exposes MCP-compatible skill manifests with action tools gated by risk", () => {
    const registry = new ToolRegistry();
    const manifests = registry.manifests();

    expect(manifests).toHaveLength(26);
    expect(new Set(manifests.map((manifest) => manifest.id)).size).toBe(manifests.length);
    expect(manifests.every((manifest) => manifest.mcpCompatible)).toBe(true);
    expect(manifests.every((manifest) => manifest.skillPackId)).toBe(true);
    expect(manifests.filter((manifest) => manifest.toolClass === "action")).toHaveLength(4);
    expect(manifests.find((manifest) => manifest.id === "full_access.exec")?.defaultPermission).toBe("ask");
    expect(manifests.find((manifest) => manifest.id === "wazuh.block_ip")?.defaultPermission).toBe("ask");
  });

  it("groups registered tools into skill packs", () => {
    const registry = new ToolRegistry();
    const packs = registry.skillPacks();

    expect(packs.map((pack) => pack.id)).toEqual([
      "secops-actions",
      "secops-core",
      "secops-full-access",
      "secops-wazuh"
    ]);
    expect(packs.find((pack) => pack.id === "secops-core")?.tools).toEqual([
      "asset.inventory.lookup",
      "case.evidence.pack",
      "detection.rule.search",
      "ioc.enrich"
    ]);
    expect(packs.find((pack) => pack.id === "secops-full-access")?.tools).toEqual(["full_access.exec"]);
    expect(packs.find((pack) => pack.id === "secops-wazuh")?.tools).toEqual([
      "wazuh.agent.alerts.timeline",
      "wazuh.agent.get",
      "wazuh.agent.netaddr.list",
      "wazuh.agent.netiface.list",
      "wazuh.agent.network.summary",
      "wazuh.agent.ports.list",
      "wazuh.agent.processes.list",
      "wazuh.agents.list",
      "wazuh.alerts.search",
      "wazuh.block_ip",
      "wazuh.config.status",
      "wazuh.health",
      "wazuh.host.neighbors",
      "wazuh.ip.activity.timeline",
      "wazuh.lateral.path.summary",
      "wazuh.lateral.suspects",
      "wazuh.network.exposure.map",
      "wazuh.network.service.find",
      "wazuh.rule.hits.summary"
    ]);
    expect(packs.every((pack) => pack.mcpCompatible)).toBe(true);
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
    expect(registry.pendingApprovals()).toHaveLength(0);
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
      properties: {},
      required: [],
      additionalProperties: false
    }
  };
}
