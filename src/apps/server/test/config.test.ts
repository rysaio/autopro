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
    expect(config.toolVisibilityPath.endsWith(path.join("runtime", "config", "toolVisibility.json"))).toBe(true);
    expect(config.pluginsDir.endsWith(path.join("runtime", "plugins"))).toBe(true);
    expect(config.agentRoutingMode).toBe("deterministic");
  });

  it("enables the temporary layered rollback mode explicitly", () => {
    const config = getConfig({
      SECOPS_AGENT_ROUTING_MODE: "layered"
    });

    expect(config.agentRoutingMode).toBe("layered");
  });

  it("respects explicit model, tool visibility, and plugin path overrides", () => {
    const config = getConfig({
      SECOPS_MODEL_CONFIG_PATH: path.join(os.tmpdir(), "custom-model.json"),
      SECOPS_TOOL_VISIBILITY_PATH: path.join(os.tmpdir(), "custom-tool-visibility.json"),
      SECOPS_PLUGINS_DIR: path.join(os.tmpdir(), "secops-plugins")
    });

    expect(config.modelConfigPath).toBe(path.resolve(path.join(os.tmpdir(), "custom-model.json")));
    expect(config.toolVisibilityPath).toBe(path.resolve(path.join(os.tmpdir(), "custom-tool-visibility.json")));
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

  it("loads a bounded agent run timeout", () => {
    const configured = getConfig({ SECOPS_AGENT_RUN_TIMEOUT_MS: "1234" });
    const invalid = getConfig({ SECOPS_AGENT_RUN_TIMEOUT_MS: "0" });

    expect(configured.agentRunTimeoutMs).toBe(1234);
    expect(invalid.agentRunTimeoutMs).toBe(5 * 60 * 1000);
  });
});
