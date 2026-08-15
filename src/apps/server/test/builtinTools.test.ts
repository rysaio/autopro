import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools/registry.js";

describe("built-in tools on WSL/Linux", () => {
  it("executes the node_version sandbox preset without a shell", async () => {
    const registry = new ToolRegistry();
    const record = await registry.executeApiTool(
      "secops_command_run_sandbox",
      "builtin-node-version",
      { commandId: "node_version" },
      context()
    );

    expect(record.invocation.status).toBe("executed");
    expect(record.invocation.result).toMatchObject({
      command: "node",
      args: ["--version"]
    });
    expect(record.invocation.result.stdout).toMatch(/^v?\d+\.\d+\.\d+/);
  });

  it("executes the npm_version sandbox preset on both npm and npm.cmd platforms", async () => {
    const registry = new ToolRegistry();
    const record = await registry.executeApiTool(
      "secops_command_run_sandbox",
      "builtin-npm-version",
      { commandId: "npm_version" },
      context()
    );

    expect(record.invocation.status).toBe("executed");
    expect(record.invocation.result.command).toBe(process.platform === "win32" ? "npm.cmd" : "npm");
    expect(String(record.invocation.result.stdout).trim().length).toBeGreaterThan(0);
  });

  it("lists the sandbox directory using the no-shell preset", async () => {
    const sandboxRoot = path.resolve("runtime/builtin-tools-sandbox");
    await rm(sandboxRoot, { recursive: true, force: true });
    await mkdir(path.join(sandboxRoot, "cases"), { recursive: true });

    const registry = new ToolRegistry();
    const record = await registry.executeApiTool(
      "secops_command_run_sandbox",
      "builtin-list-sandbox",
      { commandId: "list_sandbox" },
      { ...context(), sandboxRoot }
    );

    expect(record.invocation.status).toBe("executed");
    expect(record.invocation.result.sandboxRoot).toBe(sandboxRoot);
    expect(record.invocation.result.entries).toContainEqual({ name: "cases", type: "directory" });

    await rm(sandboxRoot, { recursive: true, force: true });
  });
});

function context() {
  return {
    runId: "builtin-tools-test",
    permissionMode: "auto" as const,
    actionLevel: "sandbox" as const,
    sandboxRoot: path.resolve("runtime/builtin-tools-sandbox"),
    workspaceRoot: process.cwd()
  };
}
