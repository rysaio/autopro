import { execFile } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe("agent benchmark CLI", () => {
  it("emits a versioned JSON summary without exposing the API token", async () => {
    let authorization: string | undefined;
    const server = createServer((request, response) => {
      authorization = request.headers.authorization;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(runFixture()));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Benchmark test server did not expose a TCP port");
    }

    const token = "benchmark-secret-token";
    const script = path.resolve("..", "..", "scripts", "benchmark-agent.mjs");
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      script,
      "--base-url", `http://127.0.0.1:${address.port}`,
      "--runs", "1",
      "--json"
    ], {
      env: { ...process.env, SECOPS_API_TOKEN: token }
    });

    expect(authorization).toBe(`Bearer ${token}`);
    expect(JSON.parse(stdout)).toMatchObject({
      schemaVersion: 1,
      scenario: {
        id: "simple-no-tools-v1",
        runs: 1,
        request: {
          prompt: "Reply with a concise acknowledgement. Do not call tools.",
          enabledTools: [],
          permissionMode: "deny"
        }
      },
      environment: {
        provider: "fixture-provider",
        model: "fixture-model"
      },
      summary: {
        completedRuns: 1,
        totalDurationMs: { median: 1200, p95: 1200 },
        timeToFirstTextMs: { median: 900, p95: 900 },
        modelRequestCount: { median: 1, p95: 1 }
      }
    });
    expect(`${stdout}${stderr}`).not.toContain(token);
    expect(`${stdout}${stderr}`).not.toContain("apiKey");
  });
});

function runFixture() {
  return {
    id: "run-1",
    sessionId: "session-1",
    status: "completed",
    provider: "fixture-provider",
    model: "fixture-model",
    startedAt: "2026-08-08T00:00:00.000Z",
    completedAt: "2026-08-08T00:00:01.200Z",
    messages: [],
    toolInvocations: [],
    audit: [],
    artifacts: [],
    metrics: {
      schemaVersion: 1,
      mode: "layered",
      totalDurationMs: 1200,
      localRoutingDurationMs: 2,
      text: { timeToFirstTextMs: 900, measurement: "provider-stream" },
      model: {
        measurement: "provider-attempts",
        requestCount: 1,
        totalDurationMs: 850,
        retryCount: 0,
        requests: []
      },
      tools: { callCount: 0, totalDurationMs: 0 },
      cache: { hits: 0, misses: 0, bypasses: 0, size: 0 },
      persistence: { operationCount: 5, totalDurationMs: 4, failureCount: 0 }
    }
  };
}
