import { describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { testConfig, scriptedModelForRequest } from "./fixtures/testConfig.js";

describe("model config hot-plug API", () => {
  it("reports not configured and rejects agent runs before any connection exists", async () => {
    const app = buildServer(testConfig({}, { withModel: false }), { createModel: scriptedModelForRequest });

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json().configured).toBe(false);

    const run = await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: { messages: [{ role: "user", content: "show me the environment" }] }
    });
    expect(run.statusCode).toBe(503);
    expect(run.json().error).toMatch(/not configured/);

    const modelConfig = await app.inject({ method: "GET", url: "/api/model-config" });
    expect(modelConfig.json()).toEqual({ connections: [], activeConnectionId: null });

    await app.close();
  });

  it("creates a connection, flips health, and serves agent runs immediately", async () => {
    const app = buildServer(testConfig({}, { withModel: false }), { createModel: scriptedModelForRequest });

    const created = await app.inject({
      method: "POST",
      url: "/api/model-config",
      payload: {
        name: "Local Test Provider",
        provider: "test-provider",
        model: "test-model",
        baseUrl: "https://provider.test/v1",
        apiKey: "test-key"
      }
    });
    expect(created.statusCode).toBe(200);
    const state = created.json();
    expect(state.connections).toHaveLength(1);
    expect(state.activeConnectionId).toBe(state.connections[0].id);
    // apiKey 永不回传明文，仅暴露 apiKeySet
    expect(state.connections[0].apiKeySet).toBe(true);
    expect(state.connections[0].apiKey).toBeUndefined();

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.json().configured).toBe(true);
    expect(health.json().model).toBe("test-model");
    expect(health.json().baseUrl).toBe("https://provider.test/v1");

    const run = await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: { messages: [{ role: "user", content: "show me the environment" }] }
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().model).toBe("test-model");
    expect(run.json().status).toBe("completed");

    await app.close();
  });

  it("rejects connections with missing required fields", async () => {
    const app = buildServer(testConfig({}, { withModel: false }), { createModel: scriptedModelForRequest });

    const bad = await app.inject({
      method: "POST",
      url: "/api/model-config",
      payload: { name: "broken", provider: "x", model: "", baseUrl: "" }
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/missing required fields/);

    await app.close();
  });

  it("updates a connection and switches the active connection on the next request", async () => {
    const app = buildServer(testConfig({}, { withModel: false }), { createModel: scriptedModelForRequest });

    const first = await app.inject({
      method: "POST",
      url: "/api/model-config",
      payload: {
        name: "Provider A",
        provider: "provider-a",
        model: "model-a",
        baseUrl: "https://a.test/v1",
        apiKey: "key-a"
      }
    });
    const firstId = first.json().connections[0].id;

    const second = await app.inject({
      method: "POST",
      url: "/api/model-config",
      payload: {
        name: "Provider B",
        provider: "provider-b",
        model: "model-b",
        baseUrl: "https://b.test/v1",
        apiKey: "key-b"
      }
    });
    const secondId = second.json().connections[1].id;

    // 更新第一个连接的模型名
    const updated = await app.inject({
      method: "PUT",
      url: `/api/model-config/${firstId}`,
      payload: { model: "model-a2" }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().connections.find((c: { id: string }) => c.id === firstId).model).toBe("model-a2");

    // 切换活动连接到 B
    const activated = await app.inject({
      method: "POST",
      url: `/api/model-config/${secondId}/activate`
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json().activeConnectionId).toBe(secondId);

    const run = await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: { messages: [{ role: "user", content: "show me the environment" }] }
    });
    expect(run.json().model).toBe("model-b");
    expect(run.json().provider).toBe("provider-b");

    await app.close();
  });

  it("deletes a connection and returns to unconfigured state", async () => {
    const app = buildServer(testConfig({}, { withModel: false }), { createModel: scriptedModelForRequest });

    const created = await app.inject({
      method: "POST",
      url: "/api/model-config",
      payload: {
        name: "Temp",
        provider: "temp",
        model: "temp-model",
        baseUrl: "https://temp.test/v1"
      }
    });
    const id = created.json().connections[0].id;

    const deleted = await app.inject({ method: "DELETE", url: `/api/model-config/${id}` });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().connections).toEqual([]);

    const missing = await app.inject({ method: "DELETE", url: "/api/model-config/ghost" });
    expect(missing.statusCode).toBe(404);

    const run = await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: { messages: [{ role: "user", content: "hi" }] }
    });
    expect(run.statusCode).toBe(503);

    await app.close();
  });
});
