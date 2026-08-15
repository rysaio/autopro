import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ModelConfigStore } from "../src/runtime/modelConfigStore.js";
import { parse as parseYaml } from "yaml";

function tempStore(): { filePath: string; credentialsPath: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "secops-model-"));
  return {
    filePath: path.join(dir, "model.json"),
    credentialsPath: path.join(dir, ".credentials.yaml")
  };
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

function credentialsYaml(secret: string): string {
  return [
    "credentials:",
    "  cred-test:",
    `    secret: ${secret}`,
    ""
  ].join("\n");
}

describe("ModelConfigStore", () => {
  it("starts empty when the file does not exist", () => {
    const { filePath, credentialsPath } = tempStore();
    const store = new ModelConfigStore(filePath, credentialsPath);

    expect(store.list().connections).toEqual([]);
    expect(store.list().activeConnectionId).toBeNull();
    expect(store.resolveConnection()).toBeUndefined();
    expect(store.status().configured).toBe(false);
  });

  it("makes the first added connection active automatically", () => {
    const { filePath, credentialsPath } = tempStore();
    const store = new ModelConfigStore(filePath, credentialsPath);

    const added = store.add(validInput({ id: "conn-1" }));
    expect(added.apiKey).toBe("test-key");
    expect(added.apiKeyCredentialId).toMatch(/^cred_/);
    expect(store.list().activeConnectionId).toBe("conn-1");
    expect(store.resolveConnection()?.model).toBe("test-model");
    // 写入凭据文件，model.json 不再包含明文 apiKey
    const modelJson = JSON.parse(readFileSync(filePath, "utf8")) as { connections: Array<Record<string, unknown>> };
    expect(modelJson.connections[0]?.apiKeyCredentialId).toBe(added.apiKeyCredentialId);
    expect(modelJson.connections[0]?.apiKey).toBeUndefined();
    expect(readFileSync(credentialsPath, "utf8")).toContain("test-key");
  });

  it("rejects connections missing required fields but allows empty apiKey", () => {
    const { filePath, credentialsPath } = tempStore();
    const store = new ModelConfigStore(filePath, credentialsPath);

    expect(() => store.add(validInput({ model: "" }))).toThrow(/missing required fields/);
    expect(() => store.add(validInput({ baseUrl: "  " }))).toThrow(/missing required fields/);

    const noKey = store.add(validInput({ id: "no-key", apiKey: "" }));
    expect(noKey.apiKey).toBeUndefined();
    expect(noKey.apiKeyCredentialId).toBeUndefined();
  });

  it("rejects duplicate ids", () => {
    const { filePath, credentialsPath } = tempStore();
    const store = new ModelConfigStore(filePath, credentialsPath);

    store.add(validInput({ id: "dup" }));
    expect(() => store.add(validInput({ id: "dup" }))).toThrow(/already exists/);
  });

  it("updates fields, keeps apiKey when omitted, clears it when empty string", () => {
    const { filePath, credentialsPath } = tempStore();
    const store = new ModelConfigStore(filePath, credentialsPath);
    store.add(validInput({ id: "conn-1" }));

    const updated = store.update("conn-1", { model: "new-model" });
    expect(updated?.model).toBe("new-model");
    expect(updated?.apiKey).toBe("test-key");
    expect(updated?.apiKeyCredentialId).toBeDefined();

    const cleared = store.update("conn-1", { apiKey: "" });
    expect(cleared?.apiKey).toBeUndefined();
    expect(cleared?.apiKeyCredentialId).toBeUndefined();
    expect(store.list().connections[0]?.apiKeySet).toBe(false);
    expect(store.list().connections[0]?.apiKeyMasked).toBeUndefined();
    // 清除后凭据文件不再包含密钥
    expect(readFileSync(credentialsPath, "utf8")).not.toContain("test-key");
  });

  it("replaces the key while keeping the same credential reference", () => {
    const { filePath, credentialsPath } = tempStore();
    const store = new ModelConfigStore(filePath, credentialsPath);
    const added = store.add(validInput({ id: "conn-1" }));

    const updated = store.update("conn-1", { apiKey: "new-test-key" });
    expect(updated?.apiKey).toBe("new-test-key");
    expect(updated?.apiKeyCredentialId).toBe(added.apiKeyCredentialId);
    expect(readFileSync(credentialsPath, "utf8")).toContain("new-test-key");
  });

  it("returns undefined when updating an unknown id", () => {
    const { filePath, credentialsPath } = tempStore();
    const store = new ModelConfigStore(filePath, credentialsPath);
    expect(store.update("missing", { model: "x" })).toBeUndefined();
  });

  it("transfers active connection to the first remaining after removal", () => {
    const { filePath, credentialsPath } = tempStore();
    const store = new ModelConfigStore(filePath, credentialsPath);
    store.add(validInput({ id: "a", name: "A" }));
    store.add(validInput({ id: "b", name: "B" }));
    store.setActive("b");

    expect(store.remove("b")).toBe(true);
    expect(store.list().activeConnectionId).toBe("a");
    expect(store.remove("b")).toBe(false);
  });

  it("clears active when the last connection is removed", () => {
    const { filePath, credentialsPath } = tempStore();
    const store = new ModelConfigStore(filePath, credentialsPath);
    store.add(validInput({ id: "only" }));

    expect(store.remove("only")).toBe(true);
    expect(store.list().activeConnectionId).toBeNull();
    expect(store.resolveConnection()).toBeUndefined();
  });

  it("switches the active connection via setActive", () => {
    const { filePath, credentialsPath } = tempStore();
    const store = new ModelConfigStore(filePath, credentialsPath);
    store.add(validInput({ id: "a", name: "A", model: "model-a" }));
    store.add(validInput({ id: "b", name: "B", model: "model-b" }));

    expect(store.setActive("b")?.model).toBe("model-b");
    expect(store.resolveConnection()?.model).toBe("model-b");
    expect(store.setActive("missing")).toBeUndefined();
  });

  it("persists to disk and reloads on a new instance", () => {
    const { filePath, credentialsPath } = tempStore();
    const first = new ModelConfigStore(filePath, credentialsPath);
    first.add(validInput({ id: "persisted" }));
    first.setActive("persisted");

    const second = new ModelConfigStore(filePath, credentialsPath);
    expect(second.list().connections).toHaveLength(1);
    expect(second.list().connections[0]?.id).toBe("persisted");
    expect(second.resolveConnection()?.apiKey).toBe("test-key");

    const modelJson = JSON.parse(readFileSync(filePath, "utf8")) as { connections: Array<Record<string, unknown>> };
    expect(modelJson.connections[0]?.apiKey).toBeUndefined();
    expect(typeof modelJson.connections[0]?.apiKeyCredentialId).toBe("string");
  });

  it("reports status from the active connection only", () => {
    const { filePath, credentialsPath } = tempStore();
    const store = new ModelConfigStore(filePath, credentialsPath);
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

  it("reload() picks up external file edits after construction (post-startup config)", () => {
    const { filePath, credentialsPath } = tempStore();
    const store = new ModelConfigStore(filePath, credentialsPath);
    expect(store.resolveConnection()).toBeUndefined();

    // 模拟启动后用户直接编辑 model.json 与 .credentials.yaml，再显式 reload
    writeFileSync(credentialsPath, credentialsYaml("sk-new"), "utf8");
    writeFileSync(filePath, JSON.stringify({
      connections: [{
        id: "edited-conn",
        name: "edited",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        baseUrl: "https://api.deepseek.com",
        apiKeyCredentialId: "cred-test"
      }],
      activeConnectionId: "edited-conn"
    }), "utf8");

    expect(store.resolveConnection()).toBeUndefined(); // reload 前不生效
    store.reload();
    expect(store.resolveConnection()?.model).toBe("deepseek-v4-flash");
    expect(store.resolveConnection()?.apiKey).toBe("sk-new");
    expect(store.list().connections[0]?.apiKeySet).toBe(true);
    expect(store.list().connections[0]?.apiKeyMasked).toBe("s***w");
  });

  it("reload() replaces in-memory config with changed file content", () => {
    const { filePath, credentialsPath } = tempStore();
    const store = new ModelConfigStore(filePath, credentialsPath);
    store.add(validInput({ id: "conn-1", model: "model-old" }));
    expect(store.resolveConnection()?.model).toBe("model-old");

    // 外部修改文件中的 model（保留凭据引用不变）
    const modelJson = JSON.parse(readFileSync(filePath, "utf8")) as {
      connections: Array<{ id: string; model: string }>;
      activeConnectionId: string;
    };
    modelJson.connections[0]!.model = "model-new";
    writeFileSync(filePath, JSON.stringify(modelJson, null, 2), "utf8");

    store.reload();
    expect(store.resolveConnection()?.model).toBe("model-new");
    expect(store.resolveConnection()?.apiKey).toBe("test-key");
  });

  it("reload() treats a deleted file as empty configuration", () => {
    const { filePath, credentialsPath } = tempStore();
    const store = new ModelConfigStore(filePath, credentialsPath);
    store.add(validInput({ id: "conn-1" }));
    expect(store.resolveConnection()).toBeDefined();

    rmSync(filePath);
    store.reload();
    expect(store.resolveConnection()).toBeUndefined();
    expect(store.list().connections).toEqual([]);
  });

  it("migrates legacy plaintext apiKey from model.json into the credentials file", () => {
    const { filePath, credentialsPath } = tempStore();
    writeFileSync(filePath, JSON.stringify({
      connections: [{
        id: "legacy-conn",
        name: "legacy",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        baseUrl: "https://api.deepseek.com",
        apiKey: "sk-legacy"
      }],
      activeConnectionId: "legacy-conn"
    }), "utf8");

    const store = new ModelConfigStore(filePath, credentialsPath);

    expect(store.resolveConnection()?.apiKey).toBe("sk-legacy");
    expect(store.resolveConnection()?.apiKeyCredentialId).toMatch(/^cred_/);
    expect(store.list().connections[0]?.apiKeyMasked).toBe("sk-***acy");

    const modelJson = JSON.parse(readFileSync(filePath, "utf8")) as { connections: Array<Record<string, unknown>> };
    expect(modelJson.connections[0]?.apiKey).toBeUndefined();
    expect(typeof modelJson.connections[0]?.apiKeyCredentialId).toBe("string");

    const parsedCredentials = parseYaml(readFileSync(credentialsPath, "utf8")) as {
      credentials: Record<string, { secret: string }>;
    };
    const credential = Object.values(parsedCredentials.credentials)[0];
    expect(credential?.secret).toBe("sk-legacy");
  });
});
