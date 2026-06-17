import { describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import path from "node:path";
import { AgentRuntime } from "../src/runtime/agentRuntime.js";
import { ToolRegistry } from "../src/tools/registry.js";
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
});
