import { describe, expect, it, vi } from "vitest";
import type { LanguageModel } from "ai";
import { ModelClientCache, fingerprintConnection } from "../src/runtime/modelClientCache.js";
import type { ModelConnection } from "../src/runtime/modelConfigStore.js";
import { createScriptedModel } from "./fixtures/scriptedModel.js";

function connection(overrides: Partial<ModelConnection> = {}): ModelConnection {
  return {
    id: "conn-1",
    name: "Test",
    provider: "test-provider",
    model: "test-model",
    baseUrl: "https://provider.test/v1",
    apiKey: "secret-key",
    ...overrides
  };
}

function captureModels() {
  const models: LanguageModel[] = [];
  return {
    models,
    createModel: vi.fn((conn: ModelConnection) => {
      const model = createScriptedModel("Reply without calling a tool.");
      models.push(model);
      return model;
    })
  };
}

describe("ModelClientCache", () => {
  it("reuses the same client for consecutive acquisitions of an unchanged connection", () => {
    const { createModel, models } = captureModels();
    const cache = new ModelClientCache({ createModel });

    const first = cache.acquire(connection());
    const second = cache.acquire(connection());

    expect(second.model).toBe(first.model);
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(createModel).toHaveBeenCalledTimes(1);
    expect(models).toHaveLength(1);
  });

  it("reuses the same client for concurrent acquisitions", async () => {
    const { createModel } = captureModels();
    const cache = new ModelClientCache({ createModel });

    const acquisitions = await Promise.all(
      Array.from({ length: 8 }, () => Promise.resolve(cache.acquire(connection())))
    );
    const uniqueModels = new Set(acquisitions.map((a) => a.model));
    expect(uniqueModels.size).toBe(1);
    expect(createModel).toHaveBeenCalledTimes(1);
  });

  it("creates a new client when provider, model, endpoint, or api key changes", () => {
    const { createModel } = captureModels();
    const cache = new ModelClientCache({ createModel });

    cache.acquire(connection({ model: "model-a" }));
    cache.acquire(connection({ model: "model-b" }));
    expect(createModel).toHaveBeenCalledTimes(2);

    cache.acquire(connection({ provider: "provider-x" }));
    expect(createModel).toHaveBeenCalledTimes(3);

    cache.acquire(connection({ baseUrl: "https://other.test/v1" }));
    expect(createModel).toHaveBeenCalledTimes(4);

    cache.acquire(connection({ apiKey: "changed-key" }));
    expect(createModel).toHaveBeenCalledTimes(5);

    // 回到最初的配置也不复用已被替换的旧 client（同 id 条目已被替换）
    cache.acquire(connection({ model: "model-a" }));
    expect(createModel).toHaveBeenCalledTimes(6);
  });

  it("keeps clients for distinct connections separate", () => {
    const { createModel } = captureModels();
    const cache = new ModelClientCache({ createModel });

    const a = cache.acquire(connection({ id: "conn-a" }));
    const b = cache.acquire(connection({ id: "conn-b" }));
    expect(a.model).not.toBe(b.model);
    expect(createModel).toHaveBeenCalledTimes(2);
  });

  it("invalidates a connection so the next acquisition creates a fresh client", () => {
    const { createModel, models } = captureModels();
    const cache = new ModelClientCache({ createModel });

    const first = cache.acquire(connection());
    first.release();
    cache.invalidate("conn-1");

    const second = cache.acquire(connection());
    expect(second.model).not.toBe(first.model);
    expect(second.reused).toBe(false);
    expect(createModel).toHaveBeenCalledTimes(2);
    expect(models).toHaveLength(2);
  });

  it("disposes an invalidated client only after the active run releases it", async () => {
    const { createModel } = captureModels();
    const disposed: LanguageModel[] = [];
    const cache = new ModelClientCache({
      createModel,
      disposeModel: vi.fn((model: LanguageModel) => {
        disposed.push(model);
      })
    });

    const first = cache.acquire(connection());
    cache.invalidate("conn-1");
    // 活跃引用未归零：不得立即释放
    expect(disposed).toHaveLength(0);

    first.release();
    expect(disposed).toEqual([first.model]);

    const second = cache.acquire(connection());
    expect(second.model).not.toBe(first.model);
  });

  it("disposes an idle invalidated client immediately", async () => {
    const { createModel } = captureModels();
    const disposed: LanguageModel[] = [];
    const cache = new ModelClientCache({
      createModel,
      disposeModel: vi.fn((model: LanguageModel) => {
        disposed.push(model);
      })
    });

    const first = cache.acquire(connection());
    first.release();
    cache.invalidate("conn-1");

    expect(disposed).toEqual([first.model]);
  });

  it("invalidates all entries for a full reload", async () => {
    const { createModel } = captureModels();
    const disposed: LanguageModel[] = [];
    const cache = new ModelClientCache({
      createModel,
      disposeModel: vi.fn((model: LanguageModel) => {
        disposed.push(model);
      })
    });

    const a = cache.acquire(connection({ id: "conn-a" }));
    const b = cache.acquire(connection({ id: "conn-b" }));
    a.release();
    b.release();

    cache.invalidateAll();
    expect(disposed).toHaveLength(2);
    expect(createModel).toHaveBeenCalledTimes(2);
  });

  it("never disposes an in-use client when a newer one supersedes it", async () => {
    const disposed: LanguageModel[] = [];
    const cache = new ModelClientCache({
      createModel: () => createScriptedModel("Reply without calling a tool."),
      disposeModel: vi.fn((model: LanguageModel) => {
        disposed.push(model);
      })
    });

    const a = cache.acquire(connection());
    cache.invalidate("conn-1");
    // 新 run 在旧 client 仍活跃时获取 → 旧条目转入 retired，不得立即释放
    const b = cache.acquire(connection());
    expect(disposed).toHaveLength(0);

    a.release();
    expect(disposed).toEqual([a.model]);

    // b 归零：条目仍有效，不释放
    b.release();
    expect(disposed).toHaveLength(1);

    // 之后失效 b → 释放
    cache.invalidate("conn-1");
    expect(disposed).toEqual([a.model, b.model]);
  });

  it("counts creation failures and rethrows", () => {
    const createModel = vi.fn(() => {
      throw new Error("boom");
    });
    const cache = new ModelClientCache({ createModel });

    expect(() => cache.acquire(connection())).toThrow("boom");
    const snapshot = cache.snapshot();
    expect(snapshot.totalCreated).toBe(0);
    expect(snapshot.totalCreationFailures).toBe(1);
  });

  it("dispose closes every cached client and rejects later acquisitions", async () => {
    const { createModel } = captureModels();
    const disposed: LanguageModel[] = [];
    const cache = new ModelClientCache({
      createModel,
      disposeModel: vi.fn((model: LanguageModel) => {
        disposed.push(model);
      })
    });

    const a = cache.acquire(connection({ id: "conn-a" }));
    const b = cache.acquire(connection({ id: "conn-b" }));
    await cache.dispose();

    expect(disposed).toEqual([a.model, b.model]);
    expect(cache.snapshot().connections).toEqual([]);
    expect(() => cache.acquire(connection())).toThrow(/closed/);
  });

  it("exposes lifecycle metrics separately and never leaks the api key", () => {
    const { createModel } = captureModels();
    const cache = new ModelClientCache({ createModel });

    const first = cache.acquire(connection());
    const second = cache.acquire(connection());
    first.release();
    second.release();
    cache.invalidate("conn-1");
    cache.acquire(connection());

    const snapshot = cache.snapshot();
    expect(snapshot.totalCreated).toBe(2);
    expect(snapshot.totalReused).toBe(1);
    expect(snapshot.totalInvalidated).toBe(1);
    expect(snapshot.totalDisposed).toBe(1);

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("secret-key");
    expect(serialized).not.toContain("apiKey");
    // 连接级累计指标在条目替换后保留
    expect(snapshot.connections).toContainEqual({
      connectionId: "conn-1",
      created: 2,
      reused: 1,
      invalidated: 1,
      creationFailures: 0,
      disposed: 1,
      active: 1
    });
  });

  it("fingerprints differ per configuration and do not contain the key", () => {
    const base = connection();
    const differentKey = fingerprintConnection({ ...base, apiKey: "other-key" });
    const differentModel = fingerprintConnection({ ...base, model: "other-model" });
    const same = fingerprintConnection(base);

    expect(differentKey).not.toBe(same);
    expect(differentModel).not.toBe(same);
    expect(same).not.toContain("secret-key");
    expect(same).toMatch(/^[0-9a-f]{64}$/);
  });
});
