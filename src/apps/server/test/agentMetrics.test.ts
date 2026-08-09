import { describe, expect, it } from "vitest";
import type {
  LanguageModelV2,
  LanguageModelV2CallOptions,
  LanguageModelV2StreamResult,
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult
} from "@ai-sdk/provider";
import { APICallError } from "@ai-sdk/provider";
import { buildServer } from "../src/app.js";
import { scriptedModelForRequest, testConfig } from "./fixtures/testConfig.js";
import { streamResultFromGenerateResult } from "./fixtures/scriptedModel.js";

describe("agent run metrics", () => {
  it("returns structured model and orchestration metrics from the run API", async () => {
    const app = buildServer(testConfig({
      SECOPS_DURABLE_SESSIONS: "on",
      SECOPS_DATA_DIR: "memory://"
    }), {
      createModel: scriptedModelForRequest,
      enableLayeredRouting: false
    });
    const sessionId = "session-http-metrics";

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: {
        sessionId,
        messages: [{ role: "user", content: "Reply without calling a tool." }],
        enabledTools: []
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("completed");
    expect(response.json().metrics).toMatchObject({
      schemaVersion: 1,
      measurementBoundary: "before-completion-export",
      mode: "single",
      totalDurationMs: expect.any(Number),
      localOrchestrationDurationMs: expect.any(Number),
      localRoutingDurationMs: expect.any(Number),
      text: {
        timeToFirstTextMs: expect.any(Number),
        measurement: "provider-stream"
      },
      model: {
        measurement: "provider-attempts",
        requestCount: 1,
        totalDurationMs: expect.any(Number),
        retryCount: 0,
        requests: [{
          phase: "single",
          durationMs: expect.any(Number),
          exposedToolCount: 0,
          outcome: "completed",
          finishReason: "stop",
          usage: {
            inputTokens: 140,
            outputTokens: 34,
            totalTokens: 174
          }
        }]
      },
      tools: {
        callCount: 0,
        totalDurationMs: 0
      },
      cache: {
        hits: 0,
        misses: 0,
        bypasses: 0
      },
      persistence: {
        operationCount: expect.any(Number),
        totalDurationMs: expect.any(Number),
        failureCount: 0
      }
    });
    const restored = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().runs).toHaveLength(1);
    expect(restored.json().runs[0].metrics).toEqual(response.json().metrics);
    expect(restored.json().runs[0].lastEvent.run.metrics).toEqual(response.json().metrics);

    await app.close();
  });

  it("counts every provider request made by a layered tool loop", async () => {
    const app = buildServer(testConfig(), { createModel: scriptedModelForRequest });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: {
        messages: [{ role: "user", content: "Investigate IOC 198.51.100.23." }],
        enabledTools: ["ioc.enrich"]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().metrics).toMatchObject({
      mode: "layered",
      model: {
        requestCount: 3,
        retryCount: 0,
        requests: [
          { phase: "triage", usage: { inputTokens: 120, outputTokens: 24, totalTokens: 144 } },
          { phase: "triage", usage: { inputTokens: 140, outputTokens: 34, totalTokens: 174 } },
          { phase: "deep", usage: { inputTokens: 140, outputTokens: 34, totalTokens: 174 } }
        ]
      },
      tools: {
        callCount: 1,
        totalDurationMs: expect.any(Number)
      },
      cache: {
        bypasses: 1
      }
    });

    await app.close();
  });

  it("counts only tool schemas that are actually exposed to the model", async () => {
    const app = buildServer(testConfig(), {
      createModel: scriptedModelForRequest,
      enableLayeredRouting: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: {
        messages: [{ role: "user", content: "Reply without calling a tool." }],
        enabledTools: ["tool.that.is.not.registered"]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().metrics.model.requests).toMatchObject([
      { phase: "single", exposedToolCount: 0 }
    ]);

    await app.close();
  });

  it("records a failed provider attempt separately from the successful retry", async () => {
    const app = buildServer(testConfig(), {
      createModel: () => new RetryOnceModel(),
      enableLayeredRouting: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: {
        messages: [{ role: "user", content: "Reply without calling a tool." }],
        enabledTools: []
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().metrics.model).toMatchObject({
      measurement: "provider-attempts",
      requestCount: 2,
      retryCount: 1,
      requests: [
        { outcome: "failed", phase: "single" },
        { outcome: "completed", phase: "single", finishReason: "stop" }
      ]
    });

    await app.close();
  });

  it("keeps provider metrics available for AI SDK v2 models", async () => {
    const app = buildServer(testConfig(), {
      createModel: () => new V2StreamingModel(),
      enableLayeredRouting: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: {
        messages: [{ role: "user", content: "Reply without calling a tool." }],
        enabledTools: []
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().metrics.model).toMatchObject({
      measurement: "provider-attempts",
      requestCount: 1,
      retryCount: 0,
      requests: [{
        outcome: "completed",
        finishReason: "stop",
        usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 }
      }]
    });

    await app.close();
  });
});

class RetryOnceModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider = "retry-test-provider";
  readonly modelId = "retry-test-model";
  readonly supportedUrls = {};
  private attempts = 0;

  async doGenerate(_options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    throw new Error("RetryOnceModel only supports streaming");
  }

  async doStream(_options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    this.attempts += 1;
    if (this.attempts === 1) {
      throw new APICallError({
        message: "transient provider error",
        url: "https://provider.test/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 503,
        responseHeaders: { "retry-after-ms": "0" }
      });
    }
    return streamResultFromGenerateResult({
      content: [{ type: "text", text: "Retry succeeded." }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 4, text: 4, reasoning: undefined }
      },
      warnings: []
    });
  }
}

class V2StreamingModel implements LanguageModelV2 {
  readonly specificationVersion = "v2" as const;
  readonly provider = "v2-test-provider";
  readonly modelId = "v2-test-model";
  readonly supportedUrls = {};

  async doGenerate(_options: LanguageModelV2CallOptions) {
    throw new Error("V2StreamingModel only supports streaming");
  }

  async doStream(_options: LanguageModelV2CallOptions): Promise<LanguageModelV2StreamResult> {
    return {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start" as const, warnings: [] });
          controller.enqueue({ type: "text-start" as const, id: "text-1" });
          controller.enqueue({ type: "text-delta" as const, id: "text-1", delta: "V2 response." });
          controller.enqueue({ type: "text-end" as const, id: "text-1" });
          controller.enqueue({
            type: "finish" as const,
            finishReason: "stop" as const,
            usage: {
              inputTokens: 8,
              outputTokens: 3,
              totalTokens: 11
            }
          });
          controller.close();
        }
      })
    };
  }
}
