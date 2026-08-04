import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getConfig } from "../src/config.js";

describe("config file loading", () => {
  it("loads generic model provider settings from SECOPS_CONFIG_PATH", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secops-config-"));
    const configPath = path.join(dir, "secops.config.json");
    await writeFile(configPath, JSON.stringify({
      model: {
        provider: "qwen",
        name: "qwen3.6-max-preview",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        apiKeyEnv: "TEST_PROVIDER_KEY"
      }
    }), "utf8");

    const config = getConfig({
      SECOPS_CONFIG_PATH: configPath,
      TEST_PROVIDER_KEY: "test-key"
    });

    expect(config.provider).toBe("qwen");
    expect(config.model).toBe("qwen3.6-max-preview");
    expect(config.modelBaseUrl).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
    expect(config.modelApiKey).toBe("test-key");
  });

  it("does not invent a provider model when configuration is missing", () => {
    const config = getConfig({
      SECOPS_CONFIG_PATH: path.join(os.tmpdir(), "missing-secops.config.json")
    });

    expect(config.provider).toBe("openai-compatible");
    expect(config.model).toBe("");
    expect(config.modelBaseUrl).toBeUndefined();
    expect(config.modelApiKey).toBeUndefined();
  });

  it("enables embedded durable session mode by default", () => {
    const config = getConfig({
      SECOPS_CONFIG_PATH: path.join(os.tmpdir(), "missing-secops.config.json")
    });

    expect(config.durableSessionMode).toBe("postgres");
    expect(config.dataDir.endsWith(path.join("runtime", "pgdata"))).toBe(true);
  });

  it("keeps the data directory in memory when SECOPS_DATA_DIR is memory://", () => {
    const config = getConfig({
      SECOPS_CONFIG_PATH: path.join(os.tmpdir(), "missing-secops.config.json"),
      SECOPS_DATA_DIR: "memory://"
    });

    expect(config.dataDir).toBe("memory://");
  });

  it("disables durable session mode when SECOPS_DURABLE_SESSIONS is off", () => {
    const config = getConfig({
      SECOPS_CONFIG_PATH: path.join(os.tmpdir(), "missing-secops.config.json"),
      SECOPS_DURABLE_SESSIONS: "off"
    });

    expect(config.durableSessionMode).toBe("disabled");
  });
});
