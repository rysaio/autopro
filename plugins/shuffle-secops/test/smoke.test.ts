import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

describe("shuffle smoke runner", () => {
  it("fails safely without live Shuffle configuration and does not print secrets", async () => {
    const result = await execFileAsync(process.execPath, [path.resolve("../../node_modules/tsx/dist/cli.mjs"), "src/bin/shuffle-smoke.ts"], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        SHUFFLE_API_URL: "",
        SHUFFLE_API_KEY: "secret-api-key"
      }
    });

    const output = JSON.parse(result.stdout);
    expect(output.ok).toBe(true);
    expect(output.checks.map((check: { name: string }) => check.name)).toContain("shuffle.config.status");
    expect(output.checks.map((check: { status: string }) => check.status)).toContain("skipped");
    expect(result.stdout).not.toContain("secret-api-key");
  });
});
