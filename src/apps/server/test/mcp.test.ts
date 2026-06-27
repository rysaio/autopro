import { rm } from "node:fs/promises";
import path from "node:path";
import type { SkillManifest } from "@secops-agent/shared";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { testConfig } from "./fixtures/testConfig.js";
import { mcpInputSchemaForManifest } from "../src/mcp/secopsMcpServer.js";
import { ToolRegistry } from "../src/tools/registry.js";

describe("MCP facade", () => {
  it("derives MCP input schemas from registered tool manifests", () => {
    const registry = new ToolRegistry();
    const manifests = registry.manifests();

    const iocSchema = mcpInputSchemaForManifest(requiredManifest(manifests, "ioc.enrich"));
    expect(iocSchema.indicator.safeParse("198.51.100.23").success).toBe(true);
    expect(iocSchema.indicator.safeParse("").success).toBe(true);

    const detectionSchema = mcpInputSchemaForManifest(requiredManifest(manifests, "detection.rule.search"));
    expect(detectionSchema.query.safeParse("dns").success).toBe(true);
    expect(detectionSchema.tactic.safeParse(undefined).success).toBe(true);
    expect(detectionSchema.query.safeParse(undefined).success).toBe(false);

    const commandSchema = mcpInputSchemaForManifest(requiredManifest(manifests, "command.run.sandbox"));
    expect(commandSchema.commandId.safeParse("git_status").success).toBe(true);
    expect(commandSchema.commandId.safeParse("whoami").success).toBe(false);

    const fullAccessSchema = mcpInputSchemaForManifest(requiredManifest(manifests, "full_access.exec"));
    expect(fullAccessSchema.command.safeParse("node").success).toBe(true);
    expect(fullAccessSchema.command.safeParse(undefined).success).toBe(false);
    expect(fullAccessSchema.args.safeParse(undefined).success).toBe(true);
    expect(fullAccessSchema.args.safeParse(["--version"]).success).toBe(true);
    expect(fullAccessSchema.cwd.safeParse(path.resolve("..")).success).toBe(true);

    const blockIpSchema = mcpInputSchemaForManifest(requiredManifest(manifests, "wazuh.block_ip"));
    expect(blockIpSchema.durationSeconds.safeParse(3600).success).toBe(true);
    expect(blockIpSchema.durationSeconds.safeParse("3600").success).toBe(false);
    expect(blockIpSchema.command.safeParse("firewall-drop").success).toBe(true);
    expect(blockIpSchema.command.safeParse("iptables").success).toBe(false);

    const portsSchema = mcpInputSchemaForManifest(requiredManifest(manifests, "wazuh.agent.ports.list"));
    expect(portsSchema.agentId.safeParse("001").success).toBe(true);
    expect(portsSchema.agentId.safeParse(undefined).success).toBe(false);
    expect(portsSchema.query.safeParse("state=LISTEN").success).toBe(true);
    expect(portsSchema.limit.safeParse(50).success).toBe(true);

    const alertsSchema = mcpInputSchemaForManifest(requiredManifest(manifests, "wazuh.alerts.search"));
    expect(alertsSchema.sourceIp.safeParse("203.0.113.10").success).toBe(true);
    expect(alertsSchema.agentId.safeParse("001").success).toBe(true);
    expect(alertsSchema.timeWindowMinutes.safeParse(60).success).toBe(true);

    const networkSummarySchema = mcpInputSchemaForManifest(requiredManifest(manifests, "wazuh.agent.network.summary"));
    expect(networkSummarySchema.agentId.safeParse("001").success).toBe(true);
    expect(networkSummarySchema.agentId.safeParse(undefined).success).toBe(false);
    expect(networkSummarySchema.portLimit.safeParse(100).success).toBe(true);
    expect(networkSummarySchema.portQuery.safeParse("state=LISTEN").success).toBe(true);

    const configStatusSchema = mcpInputSchemaForManifest(requiredManifest(manifests, "wazuh.config.status"));
    expect(Object.keys(configStatusSchema)).toHaveLength(0);
  });

  it("keeps MCP required fields aligned with tool manifests", () => {
    const registry = new ToolRegistry();

    for (const manifest of registry.manifests()) {
      const schema = mcpInputSchemaForManifest(manifest);
      const required = new Set(manifest.inputSchema.required ?? []);

      for (const key of Object.keys(manifest.inputSchema.properties)) {
        expect(schema[key]?.safeParse(undefined).success, `${manifest.id}.${key}`).toBe(!required.has(key));
      }
    }

    const evidencePack = requiredManifest(registry.manifests(), "case.evidence.pack");
    const evidenceSchema = mcpInputSchemaForManifest(evidencePack);
    expect(evidencePack.inputSchema.required).toContain("observations");
    expect(evidenceSchema.observations.safeParse(undefined).success).toBe(false);
  });

  it("fails fast for unsupported manifest input schemas", () => {
    const base = requiredManifest(new ToolRegistry().manifests(), "ioc.enrich");
    const unsupportedRequired: SkillManifest = {
      ...base,
      id: "unsupported.required",
      inputSchema: {
        type: "object",
        properties: {
          enabled: { type: "boolean" }
        },
        required: ["enabled"],
        additionalProperties: false
      }
    };
    const mixedEnum: SkillManifest = {
      ...base,
      id: "unsupported.enum",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["safe", 1] }
        },
        required: ["mode"],
        additionalProperties: false
      }
    };

    expect(() => mcpInputSchemaForManifest(unsupportedRequired)).toThrow("Unsupported MCP input schema");
    expect(() => mcpInputSchemaForManifest(mixedEnum)).toThrow("Unsupported MCP enum schema");
  });

  it("lists tools and can call a sandbox action tool", async () => {
    const sandboxRoot = path.resolve("runtime/mcp-test-sandbox");
    await rm(sandboxRoot, { recursive: true, force: true });
    const app = buildServer(testConfig({
      SECOPS_ACTION_LEVEL: "sandbox",
      SECOPS_SANDBOX_ROOT: sandboxRoot
    }));

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/mcp/tools"
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json().tools).toHaveLength(38);

    const skillResponse = await app.inject({
      method: "GET",
      url: "/api/mcp/skills"
    });
    expect(skillResponse.statusCode).toBe(200);
    expect(skillResponse.json().skills.map((skill: { id: string }) => skill.id)).toContain("secops-actions");
    expect(skillResponse.json().skills.map((skill: { id: string }) => skill.id)).toContain("secops-wazuh");
    expect(skillResponse.json().skills.map((skill: { id: string }) => skill.id)).toContain("secops-shuffle");

    const callResponse = await app.inject({
      method: "POST",
      url: "/api/mcp/tools/secops_case_note_write/call",
      payload: {
        args: {
          caseId: "INC-MCP-1",
          title: "MCP write smoke",
          body: "MCP facade wrote this note inside the sandbox."
        }
      }
    });

    expect(callResponse.statusCode).toBe(200);
    const body = callResponse.json();
    expect(body.invocation.status).toBe("executed");
    expect(JSON.stringify(body.invocation.result)).toContain("INC-MCP-1");
    await app.close();
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  it("rejects invalid MCP facade inputs before approval persistence", async () => {
    const sandboxRoot = path.resolve("runtime/mcp-invalid-input-sandbox");
    const approvalStorePath = path.resolve("runtime/mcp-invalid-input-approvals/pending.json");
    await rm(sandboxRoot, { recursive: true, force: true });
    await rm(path.dirname(approvalStorePath), { recursive: true, force: true });
    const app = buildServer(testConfig({
      SECOPS_ACTION_LEVEL: "sandbox",
      SECOPS_SANDBOX_ROOT: sandboxRoot,
      SECOPS_APPROVAL_STORE_PATH: approvalStorePath
    }));

    const missingRequired = await app.inject({
      method: "POST",
      url: "/api/mcp/tools/secops_case_note_write/call",
      payload: {
        permissionMode: "ask",
        args: {
          caseId: "INC-MCP-INVALID",
          title: "Missing body"
        }
      }
    });
    expect(missingRequired.statusCode).toBe(200);
    expect(missingRequired.json().invocation.status).toBe("failed");
    expect(missingRequired.json().invocation.error).toContain("Missing required argument");

    const invalidEnum = await app.inject({
      method: "POST",
      url: "/api/tools/command.run.sandbox/invoke",
      payload: {
        commandId: "whoami"
      }
    });
    expect(invalidEnum.statusCode).toBe(200);
    expect(invalidEnum.json().invocation.status).toBe("failed");
    expect(invalidEnum.json().invocation.error).toContain("Invalid value");

    const approvals = await app.inject({
      method: "GET",
      url: "/api/approvals"
    });
    expect(approvals.json().approvals).toHaveLength(0);

    await app.close();
    await rm(sandboxRoot, { recursive: true, force: true });
    await rm(path.dirname(approvalStorePath), { recursive: true, force: true });
  });
});

function requiredManifest(manifests: ReturnType<ToolRegistry["manifests"]>, id: string) {
  const manifest = manifests.find((item) => item.id === id);
  if (!manifest) {
    throw new Error(`Missing manifest ${id}`);
  }
  return manifest;
}
