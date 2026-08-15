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
    expect(config.credentialsPath.endsWith(path.join(".credentials.yaml"))).toBe(true);
    expect(config.toolVisibilityPath.endsWith(path.join("runtime", "config", "toolVisibility.json"))).toBe(true);
    expect(config.pluginsDir.endsWith(path.join("runtime", "plugins"))).toBe(true);
  });

  it("respects explicit model, tool visibility, and plugin path overrides", () => {
    const config = getConfig({
      SECOPS_MODEL_CONFIG_PATH: path.join(os.tmpdir(), "custom-model.json"),
      SECOPS_CREDENTIALS_PATH: path.join(os.tmpdir(), "custom-credentials.yaml"),
      SECOPS_TOOL_VISIBILITY_PATH: path.join(os.tmpdir(), "custom-tool-visibility.json"),
      SECOPS_PLUGINS_DIR: path.join(os.tmpdir(), "secops-plugins")
    });

    expect(config.modelConfigPath).toBe(path.resolve(path.join(os.tmpdir(), "custom-model.json")));
    expect(config.credentialsPath).toBe(path.resolve(path.join(os.tmpdir(), "custom-credentials.yaml")));
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
});

describe("WSL path portability", () => {
  it("rewrites Windows drive-letter paths on Linux/WSL", () => {
    const config = getConfig({
      SECOPS_WORKSPACE_ROOT: "C:\\work\\secops-agent",
      SECOPS_SANDBOX_ROOT: "C:\\data\\sandbox",
      SECOPS_DATA_DIR: "C:/data/pgdata"
    });

    expect(config.workspaceRoot).toBe("/mnt/c/work/secops-agent");
    expect(config.sandboxRoot).toBe("/mnt/c/data/sandbox");
    expect(config.dataDir).toBe("/mnt/c/data/pgdata");
  });

  it("rewrites wsl$ UNC paths to Linux paths", () => {
    const config = getConfig({
      SECOPS_SANDBOX_ROOT: "\\\\wsl$\\Ubuntu\\home\\me\\runtime\\sandbox"
    });

    expect(config.sandboxRoot).toBe("/home/me/runtime/sandbox");
  });
});
