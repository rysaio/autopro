import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getConfig } from "../src/config.js";

describe("config loading", () => {
  it("defaults model config and plugin dirs under the workspace runtime dir", () => {
    const config = getConfig({
      SECOPS_CONFIG_PATH: path.join(os.tmpdir(), "missing-secops.config.json")
    });

    expect(config.modelConfigPath.endsWith(path.join("runtime", "config", "model.json"))).toBe(true);
    expect(config.pluginsDir.endsWith(path.join("runtime", "plugins"))).toBe(true);
  });

  it("respects explicit SECOPS_MODEL_CONFIG_PATH and SECOPS_PLUGINS_DIR overrides", () => {
    const config = getConfig({
      SECOPS_MODEL_CONFIG_PATH: path.join(os.tmpdir(), "custom-model.json"),
      SECOPS_PLUGINS_DIR: path.join(os.tmpdir(), "secops-plugins")
    });

    expect(config.modelConfigPath).toBe(path.resolve(path.join(os.tmpdir(), "custom-model.json")));
    expect(config.pluginsDir).toBe(path.resolve(path.join(os.tmpdir(), "secops-plugins")));
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
