import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/app.js";
import { ModelClientCache } from "../src/runtime/modelClientCache.js";
import type { ModelConnection } from "../src/runtime/modelConfigStore.js";
import { createScriptedModel } from "./fixtures/scriptedModel.js";
import { testConfig } from "./fixtures/testConfig.js";

/**
 * Issue #9 集成验证：通过注入无请求依赖的模型工厂缓存，
 * 验证连续/并发 run 复用、配置修订防复用、移除/重载释放与指标暴露。
 */
function cacheWithScriptedFactory() {
  const createModel = vi.fn((_connection: ModelConnection) =>
    createScriptedModel("Reply without calling a tool.")
  );
  const cache = new ModelClientCache({ createModel });
  return { cache, createModel };
}

describe("model client reuse API (Issue #9)", () => {
  it("reuses one provider client across consecutive runs of the same connection", async () => {
    const { cache, createModel } = cacheWithScriptedFactory();
    const app = buildServer(testConfig(), { modelClientCache: cache });

    const first = await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: { messages: [{ role: "user", content: "show me the environment" }] }
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: { messages: [{ role: "user", content: "show me the environment" }] }
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(createModel).toHaveBeenCalledTimes(1);
    expect(first.json().metrics.modelClient).toEqual({ connectionId: "test-conn", reused: false });
    expect(second.json().metrics.modelClient).toEqual({ connectionId: "test-conn", reused: true });

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.json().modelClients).toMatchObject({
      totalCreated: 1,
      totalReused: 1,
      totalInvalidated: 0,
      totalCreationFailures: 0
    });
    expect(JSON.stringify(health.json().modelClients)).not.toContain("test-key");
    expect(JSON.stringify(health.json().modelClients)).not.toContain("apiKey");

    await app.close();
  });

  it("reuses one provider client across concurrent runs", async () => {
    const { cache, createModel } = cacheWithScriptedFactory();
    const app = buildServer(testConfig(), { modelClientCache: cache });

    const results = await Promise.all(Array.from({ length: 4 }, () => app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: { messages: [{ role: "user", content: "show me the environment" }] }
    })));

    expect(results.every((response) => response.statusCode === 200)).toBe(true);
    expect(createModel).toHaveBeenCalledTimes(1);

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.json().modelClients.totalReused).toBe(3);

    await app.close();
  });

  it("prevents reuse after a configuration revision", async () => {
    const { cache, createModel } = cacheWithScriptedFactory();
    const app = buildServer(testConfig(), { modelClientCache: cache });

    await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: { messages: [{ role: "user", content: "show me the environment" }] }
    });
    expect(createModel).toHaveBeenCalledTimes(1);

    // 修订模型名 → 旧 client 必须失效
    const updated = await app.inject({
      method: "PUT",
      url: "/api/model-config/test-conn",
      payload: { model: "test-model-v2" }
    });
    expect(updated.statusCode).toBe(200);

    const run = await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: { messages: [{ role: "user", content: "show me the environment" }] }
    });
    expect(run.json().model).toBe("test-model-v2");
    expect(createModel).toHaveBeenCalledTimes(2);

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.json().modelClients).toMatchObject({
      totalCreated: 2,
      totalInvalidated: 1
    });

    await app.close();
  });

  it("prevents reuse after removing and re-adding a connection", async () => {
    const { cache, createModel } = cacheWithScriptedFactory();
    const app = buildServer(testConfig(), { modelClientCache: cache });

    await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: { messages: [{ role: "user", content: "show me the environment" }] }
    });

    await app.inject({ method: "DELETE", url: "/api/model-config/test-conn" });
    const recreated = await app.inject({
      method: "POST",
      url: "/api/model-config",
      payload: {
        name: "Test Provider 2",
        provider: "test-provider",
        model: "test-model",
        baseUrl: "https://provider.test/v1",
        apiKey: "test-key"
      }
    });
    const newId = recreated.json().connections[0].id;

    const run = await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: { messages: [{ role: "user", content: "show me the environment" }] }
    });
    expect(run.statusCode).toBe(200);
    expect(createModel).toHaveBeenCalledTimes(2);

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.json().modelClients.totalInvalidated).toBe(1);
    expect(health.json().modelClients.connections.map((c: { connectionId: string }) => c.connectionId))
      .toContain(newId);

    await app.close();
  });

  it("invalidates all cached clients on reload", async () => {
    const { cache, createModel } = cacheWithScriptedFactory();
    const app = buildServer(testConfig(), { modelClientCache: cache });

    await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: { messages: [{ role: "user", content: "show me the environment" }] }
    });

    const reloaded = await app.inject({ method: "POST", url: "/api/model-config/reload" });
    expect(reloaded.statusCode).toBe(200);

    const run = await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: { messages: [{ role: "user", content: "show me the environment" }] }
    });
    expect(run.statusCode).toBe(200);
    expect(createModel).toHaveBeenCalledTimes(2);

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.json().modelClients.totalInvalidated).toBe(1);

    await app.close();
  });

  it("does not reuse an old client across active-connection switches", async () => {
    const { cache, createModel } = cacheWithScriptedFactory();
    const app = buildServer(testConfig(), { modelClientCache: cache });

    // 先用默认活动连接跑一次，缓存 test-conn 的 client
    await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: { messages: [{ role: "user", content: "show me the environment" }] }
    });
    expect(createModel).toHaveBeenCalledTimes(1);

    const added = await app.inject({
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
    const secondId = added.json().connections[1].id;

    // 切换活跃连接到 B
    await app.inject({ method: "POST", url: `/api/model-config/${secondId}/activate` });

    const run = await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: { messages: [{ role: "user", content: "show me the environment" }] }
    });
    expect(run.statusCode).toBe(200);
    expect(createModel).toHaveBeenCalledTimes(2);

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.json().modelClients.connections).toHaveLength(2);
    expect(health.json().modelClients.connections.map((c: { connectionId: string }) => c.connectionId))
      .toEqual(expect.arrayContaining(["test-conn", secondId]));
    await app.close();
  });
});
