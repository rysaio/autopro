import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("wazuh smoke entrypoint", () => {
  it("runs without live Wazuh configuration and reports skipped checks safely", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      path.resolve("../../node_modules/tsx/dist/cli.mjs"),
      "src/bin/wazuh-smoke.ts"
    ], {
      cwd: path.resolve("."),
      env: cleanWazuhEnv()
    });

    const result = JSON.parse(stdout) as {
      ok: boolean;
      checks: Array<{ name: string; status: string; summary?: string }>;
      notes: string[];
    };
    expect(result.ok).toBe(true);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "wazuh.config.status", status: "executed" }),
      expect.objectContaining({ name: "wazuh.server-api", status: "skipped" }),
      expect.objectContaining({ name: "wazuh.indexer", status: "skipped" }),
      expect.objectContaining({ name: "wazuh.block_ip", status: "skipped" })
    ]));
    expect(JSON.stringify(result)).not.toContain("password");
    expect(JSON.stringify(result)).not.toContain("token");
  });
});

function cleanWazuhEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("WAZUH_") || key.startsWith("SECOPS_")) {
      delete env[key];
    }
  }
  return env;
}
