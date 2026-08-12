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
      "--scenario", "simple",
      "--json"
    ], {
      env: { ...process.env, SECOPS_API_TOKEN: token }
    });

    expect(authorization).toBe(`Bearer ${token}`);
    expect(JSON.parse(stdout)).toMatchObject({
      schemaVersion: 2,
      mode: "deterministic",
      runs: 1,
      scenarios: {
        simple: {
          status: "completed",
          summary: {
            sampleCount: 1,
            completedRuns: 1,
            clientObservedDurationMs: { median: expect.any(Number), p95: expect.any(Number) },
            totalDurationMs: { median: 1200, p95: 1200 },
            timeToFirstTextMs: { median: 900, p95: 900 },
            modelRequestCount: { median: 1, p95: 1 },
            modelRetryCount: { median: 0, p95: 0 },
            toolCallCount: { median: 0, p95: 0 },
            toolHandlerCallCount: { median: 0, p95: 0 },
            toolTotalDurationMs: { median: 0, p95: 0 },
            cacheHits: 0,
            cacheMisses: 0,
            cacheBypasses: 0,
            inputTokens: { median: 140, p95: 140 },
            outputTokens: { median: 34, p95: 34 },
            persistenceFailureCount: 0
          }
        }
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
    terminalReason: "Model execution completed.",
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
      mode: "deterministic",
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
          phase: "final",
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
      tools: { callCount: 0, handlerCallCount: 0, totalDurationMs: 0 },
      cache: {
        hits: 0,
        misses: 0,
        bypasses: 0,
        size: 0,
        evictions: 0,
        expiredEntries: 0,
        invalidatedEntries: 0,
        avoidedToolDurationMs: 0
      },
      persistence: { operationCount: 5, totalDurationMs: 4, failureCount: 0 }
    }
  };
}
