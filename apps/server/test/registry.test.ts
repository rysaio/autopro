import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools/registry.js";

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
});
