import { describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { ModelClientCache } from "../src/runtime/modelClientCache.js";
import { createScriptedModel } from "./fixtures/scriptedModel.js";
import { testConfig } from "./fixtures/testConfig.js";

describe("cache usage API", () => {
  it("returns a frontend-ready process summary without secret cache material", async () => {
    const modelClientCache = new ModelClientCache({
      createModel: () => createScriptedModel("Reply without calling a tool.")
    });
    const app = buildServer(testConfig(), { modelClientCache });

    const initial = await app.inject({ method: "GET", url: "/api/cache/usage" });
    expect(initial.statusCode).toBe(200);
    expect(initial.headers["cache-control"]).toBe("no-store");
    expect(initial.json()).toMatchObject({
      schemaVersion: 1,
      scope: "process",
      generatedAt: expect.any(String),
      toolResults: {
        lookups: 0,
        hits: 0,
        misses: 0,
        hitRate: null,
        entries: 0,
        capacity: 256
      },
      modelClients: {
        acquisitions: 0,
        created: 0,
        reused: 0,
        reuseRate: null,
        trackedConnections: 0,
        activeRuns: 0
      }
    });

    const toolPayload = { indicator: "198.51.100.23" };
    const firstTool = await app.inject({
      method: "POST",
      url: "/api/tools/threat.intel.lookup/invoke",
      payload: toolPayload
    });
    const secondTool = await app.inject({
      method: "POST",
      url: "/api/tools/threat.intel.lookup/invoke",
      payload: toolPayload
    });
    expect(firstTool.json().invocation.cache.status).toBe("miss");
    expect(secondTool.json().invocation.cache.status).toBe("hit");

    const runPayload = {
      messages: [{ role: "user" as const, content: "Reply without calling a tool." }],
      enabledTools: []
    };
    const firstRun = await app.inject({ method: "POST", url: "/api/agent/run", payload: runPayload });
    const secondRun = await app.inject({ method: "POST", url: "/api/agent/run", payload: runPayload });
    expect(firstRun.statusCode).toBe(200);
    expect(secondRun.statusCode).toBe(200);

    const response = await app.inject({ method: "GET", url: "/api/cache/usage" });
    const usage = response.json();
    expect(usage).toMatchObject({
      toolResults: {
        lookups: 2,
        hits: 1,
        misses: 1,
        hitRate: 0.5,
        entries: 1
      },
      modelClients: {
        acquisitions: 2,
        created: 1,
        reused: 1,
        reuseRate: 0.5,
        trackedConnections: 1,
        activeRuns: 0
      }
    });
    expect(JSON.stringify(usage)).not.toContain("test-key");
    expect(JSON.stringify(usage)).not.toContain("apiKey");

    await app.close();
  });
});
