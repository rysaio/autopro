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
        clientObservedDurationMs: { median: expect.any(Number), p95: expect.any(Number) },
        serverTotalDurationMs: { median: 1200, p95: 1200 },
        totalDurationMs: { median: 1200, p95: 1200 },
        localOrchestrationDurationMs: { median: 340, p95: 340 },
        localRoutingDurationMs: { median: 2, p95: 2 },
        timeToFirstTextMs: { median: 900, p95: 900 },
        modelRequestCount: { median: 1, p95: 1 },
        provider: {
          totalDurationMs: { median: 850, p95: 850 },
          requestCount: { median: 1, p95: 1 },
          retryCount: { median: 0, p95: 0 },
          phases: {
            single: {
              durationMs: { median: 850, p95: 850 },
              exposedToolCount: { median: 0, p95: 0 },
              finishReasons: { stop: 1 }
            }
          }
        },
        tools: {
          callCount: { median: 0, p95: 0 },
          totalDurationMs: { median: 0, p95: 0 }
        },
        cache: {
          hits: { median: 0, p95: 0 },
          misses: { median: 0, p95: 0 },
          bypasses: { median: 0, p95: 0 }
        },
        persistence: {
          operationCount: { median: 5, p95: 5 },
          totalDurationMs: { median: 4, p95: 4 },
          failureCount: { median: 0, p95: 0 }
        },
        tokens: {
          input: { median: 140, p95: 140 },
          output: { median: 34, p95: 34 },
          cacheRead: { median: 20, p95: 20 },
          cacheWrite: { median: 3, p95: 3 },
          reasoning: { median: 6, p95: 6 }
        },
        inputTokens: { median: 140, p95: 140 },
        outputTokens: { median: 34, p95: 34 }
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
      measurementBoundary: "before-completion-export",
      mode: "layered",
      totalDurationMs: 1200,
      localOrchestrationDurationMs: 340,
      localRoutingDurationMs: 2,
      text: { timeToFirstTextMs: 900, measurement: "provider-stream" },
      model: {
        measurement: "provider-attempts",
        requestCount: 1,
        totalDurationMs: 850,
        retryCount: 0,
        requests: [{
          phase: "single",
          durationMs: 850,
          exposedToolCount: 0,
          outcome: "completed",
          finishReason: "stop",
          usage: {
            inputTokens: 140,
            outputTokens: 34,
            totalTokens: 174,
            cacheReadTokens: 20,
            cacheWriteTokens: 3,
            reasoningTokens: 6
          }
        }]
      },
      tools: { callCount: 0, totalDurationMs: 0 },
      cache: { hits: 0, misses: 0, bypasses: 0, size: 0 },
      persistence: { operationCount: 5, totalDurationMs: 4, failureCount: 0 }
    }
  };
}
