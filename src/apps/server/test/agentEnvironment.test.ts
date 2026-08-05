import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { AgentEnvironment } from "../src/runtime/agentEnvironment.js";
import { ModelConfigStore } from "../src/runtime/modelConfigStore.js";
import { RuntimeSettingsStore } from "../src/runtime/runtimeSettings.js";
import { PluginManager, type McpClientHandle, type ResolvedMcpServer } from "../src/plugins/pluginManager.js";
import { ToolRegistry } from "../src/tools/registry.js";

async function buildEnvironment(settingsPath: string, modelPath: string, pluginsDir: string): Promise<AgentEnvironment> {
  const settings = new RuntimeSettingsStore(settingsPath, { actionLevel: "sandbox" });
  const models = new ModelConfigStore(modelPath);
  const registry = new ToolRegistry();
  const plugins = new PluginManager({
    pluginsDir,
    registry,
    createClient: async (_server: ResolvedMcpServer, pluginId: string): Promise<McpClientHandle> => {
      const tools: Tool[] = [{
        name: `secops_${pluginId}_query`,
        title: `${pluginId} Query`,
        description: "Query tool.",
        inputSchema: { type: "object", properties: {} },
        _meta: { manifestId: `${pluginId}.query`, risk: "low", permission: "auto", toolClass: "perception" }
      }];
      return {
        listTools: async () => tools,
        callTool: async (_name: string, _args: Record<string, unknown>): Promise<CallToolResult> => ({
          content: [{ type: "text", text: JSON.stringify({ status: "executed", result: { ok: true } }) }]
        }),
        close: async () => undefined
      };
    }
  });
  return new AgentEnvironment(settings, models, plugins);
}

describe("AgentEnvironment", () => {
  it("aggregates model, plugin, and settings status", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secops-env-"));
    const models = new ModelConfigStore(path.join(dir, "model.json"));
    models.add({
      id: "conn-1",
      name: "Env Provider",
      provider: "env-provider",
      model: "env-model",
      baseUrl: "https://env.test/v1",
      apiKey: "key"
    });
    const settings = new RuntimeSettingsStore(path.join(dir, "settings.json"), { actionLevel: "full-access" });
    const pluginsDir = path.join(dir, "plugins");
    await writeFakePlugin(pluginsDir, "demo");

    const environment = new AgentEnvironment(settings, models, new PluginManager({
      pluginsDir,
      registry: new ToolRegistry(),
      createClient: async (_server: ResolvedMcpServer, pluginId: string): Promise<McpClientHandle> => ({
        listTools: async () => [{
          name: `secops_${pluginId}_query`,
          title: "q",
          description: "q",
          inputSchema: { type: "object", properties: {} },
          _meta: { manifestId: `${pluginId}.query`, risk: "low", permission: "auto", toolClass: "perception" }
        }],
        callTool: async (_name: string, _args: Record<string, unknown>): Promise<CallToolResult> => ({
          content: [{ type: "text", text: "{}" }]
        }),
        close: async () => undefined
      })
    }));
    await environment.loadAll();

    const status = environment.status();
    expect(status.model).toMatchObject({
      configured: true,
      provider: "env-provider",
      model: "env-model",
      baseUrl: "https://env.test/v1",
      connections: 1,
      activeConnectionId: "conn-1"
    });
    expect(status.plugins).toEqual({
      installed: 1,
      loaded: 1,
      failed: 0,
      plugins: [expect.objectContaining({ id: "demo", status: "loaded", toolCount: 1 })]
    });
    expect(status.settings.actionLevel).toBe("full-access");
  });

  it("reports unconfigured model and failed plugins without throwing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secops-env-"));
    const environment = await buildEnvironment(
      path.join(dir, "settings.json"),
      path.join(dir, "model.json"),
      path.join(dir, "plugins")
    );
    // 无 manifest 的目录 → 插件加载失败但基座状态正常聚合
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(dir, "plugins", "broken"), { recursive: true });
    await environment.loadAll();

    const status = environment.status();
    expect(status.model.configured).toBe(false);
    expect(status.plugins.installed).toBe(1);
    expect(status.plugins.failed).toBe(1);
    expect(status.plugins.loaded).toBe(0);
    expect(status.settings.actionLevel).toBe("sandbox");
  });

  it("reloadAll refreshes plugins via their own hot-reload semantics", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "secops-env-"));
    const environment = await buildEnvironment(
      path.join(dir, "settings.json"),
      path.join(dir, "model.json"),
      path.join(dir, "plugins")
    );
    await environment.loadAll();
    expect(environment.status().plugins.installed).toBe(0);

    await writeFakePlugin(path.join(dir, "plugins"), "late-plugin");
    await environment.reloadAll();

    expect(environment.status().plugins.installed).toBe(1);
    expect(environment.status().plugins.plugins[0]).toMatchObject({ id: "late-plugin", status: "loaded" });
  });
});

async function writeFakePlugin(pluginsDir: string, id: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const dir = path.join(pluginsDir, id);
  await mkdir(path.join(dir, ".codex-plugin"), { recursive: true });
  await writeFile(path.join(dir, ".codex-plugin", "plugin.json"), JSON.stringify({ name: id, version: "0.1.0" }), "utf8");
  await writeFile(path.join(dir, ".mcp.json"), JSON.stringify({
    mcpServers: { [id]: { command: "node", args: ["./dist/bin/fake.js"] } }
  }), "utf8");
}
