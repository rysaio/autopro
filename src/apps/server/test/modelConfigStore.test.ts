import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ModelConfigStore } from "../src/runtime/modelConfigStore.js";

function tempStore(): { filePath: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "secops-model-"));
  return { filePath: path.join(dir, "model.json") };
}

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "test-provider",
    provider: "openai-compatible",
    model: "test-model",
    baseUrl: "https://provider.test/v1",
    apiKey: "test-key",
    ...overrides
  };
}

describe("ModelConfigStore", () => {
  it("starts empty when the file does not exist", () => {
    const { filePath } = tempStore();
    const store = new ModelConfigStore(filePath);

    expect(store.list().connections).toEqual([]);
    expect(store.list().activeConnectionId).toBeNull();
    expect(store.resolveConnection()).toBeUndefined();
    expect(store.status().configured).toBe(false);
  });

  it("makes the first added connection active automatically", () => {
    const { filePath } = tempStore();
    const store = new ModelConfigStore(filePath);

    const added = store.add(validInput({ id: "conn-1" }));
    expect(added.apiKey).toBe("test-key");
    expect(store.list().activeConnectionId).toBe("conn-1");
    expect(store.resolveConnection()?.model).toBe("test-model");
  });

  it("rejects connections missing required fields but allows empty apiKey", () => {
    const { filePath } = tempStore();
    const store = new ModelConfigStore(filePath);

    expect(() => store.add(validInput({ model: "" }))).toThrow(/missing required fields/);
    expect(() => store.add(validInput({ baseUrl: "  " }))).toThrow(/missing required fields/);

    const noKey = store.add(validInput({ id: "no-key", apiKey: "" }));
    expect(noKey.apiKey).toBeUndefined();
  });

  it("rejects duplicate ids", () => {
    const { filePath } = tempStore();
    const store = new ModelConfigStore(filePath);

    store.add(validInput({ id: "dup" }));
    expect(() => store.add(validInput({ id: "dup" }))).toThrow(/already exists/);
  });

  it("updates fields, keeps apiKey when omitted, clears it when empty string", () => {
    const { filePath } = tempStore();
    const store = new ModelConfigStore(filePath);
    store.add(validInput({ id: "conn-1" }));

    const updated = store.update("conn-1", { model: "new-model" });
    expect(updated?.model).toBe("new-model");
    expect(updated?.apiKey).toBe("test-key");

    const cleared = store.update("conn-1", { apiKey: "" });
    expect(cleared?.apiKey).toBeUndefined();
    expect(store.list().connections[0]?.apiKeySet).toBe(false);
  });

  it("returns undefined when updating an unknown id", () => {
    const { filePath } = tempStore();
    const store = new ModelConfigStore(filePath);
    expect(store.update("missing", { model: "x" })).toBeUndefined();
  });

  it("transfers active connection to the first remaining after removal", () => {
    const { filePath } = tempStore();
    const store = new ModelConfigStore(filePath);
    store.add(validInput({ id: "a", name: "A" }));
    store.add(validInput({ id: "b", name: "B" }));
    store.setActive("b");

    expect(store.remove("b")).toBe(true);
    expect(store.list().activeConnectionId).toBe("a");
    expect(store.remove("b")).toBe(false);
  });

  it("clears active when the last connection is removed", () => {
    const { filePath } = tempStore();
    const store = new ModelConfigStore(filePath);
    store.add(validInput({ id: "only" }));

    expect(store.remove("only")).toBe(true);
    expect(store.list().activeConnectionId).toBeNull();
    expect(store.resolveConnection()).toBeUndefined();
  });

  it("switches the active connection via setActive", () => {
    const { filePath } = tempStore();
    const store = new ModelConfigStore(filePath);
    store.add(validInput({ id: "a", name: "A", model: "model-a" }));
    store.add(validInput({ id: "b", name: "B", model: "model-b" }));

    expect(store.setActive("b")?.model).toBe("model-b");
    expect(store.resolveConnection()?.model).toBe("model-b");
    expect(store.setActive("missing")).toBeUndefined();
  });

  it("persists to disk and reloads on a new instance", () => {
    const { filePath } = tempStore();
    const first = new ModelConfigStore(filePath);
    first.add(validInput({ id: "persisted" }));
    first.setActive("persisted");

    const second = new ModelConfigStore(filePath);
    expect(second.list().connections).toHaveLength(1);
    expect(second.list().connections[0]?.id).toBe("persisted");
    expect(second.resolveConnection()?.apiKey).toBe("test-key");
    expect(JSON.parse(readFileSync(filePath, "utf8")).connections[0].apiKey).toBe("test-key");
  });

  it("reports status from the active connection only", () => {
    const { filePath } = tempStore();
    const store = new ModelConfigStore(filePath);
    store.add(validInput({ id: "a", model: "active-model", baseUrl: "https://active.test/v1" }));
    store.add(validInput({ id: "b", model: "other-model", baseUrl: "https://other.test/v1" }));
    store.setActive("a");

    const status = store.status();
    expect(status.configured).toBe(true);
    expect(status.provider).toBe("openai-compatible");
    expect(status.model).toBe("active-model");
    expect(status.baseUrl).toBe("https://active.test/v1");
    expect(status.connections).toBe(2);
    expect(status.activeConnectionId).toBe("a");
  });
});
