import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { PluginManager, type McpClientHandle, type ResolvedMcpServer } from "../src/plugins/pluginManager.js";
import { PluginCachePolicyStore } from "../src/runtime/pluginCachePolicyStore.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolContext } from "../src/tools/types.js";

interface FakePluginSetup {
  pluginsDir: string;
  registry: ToolRegistry;
  cachePolicies: PluginCachePolicyStore;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  toolsByPlugin: Record<string, Tool[]>;
  resultByTool: Record<string, unknown>;
}

async function setupPluginManager(): Promise<{ manager: PluginManager; setup: FakePluginSetup }> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "secops-plugin-cache-"));
  const pluginsDir = path.join(tmp, "plugins");
  const registry = new ToolRegistry();
  const cachePolicies = new PluginCachePolicyStore(path.join(tmp, "pluginCache.json"));
  const setup: FakePluginSetup = {
    pluginsDir,
    registry,
    cachePolicies,
    calls: [],
    toolsByPlugin: {},
    resultByTool: {}
  };
  const manager = new PluginManager({
    pluginsDir,
    registry,
    cachePolicyStore: cachePolicies,
    createClient: async (server: ResolvedMcpServer, pluginId: string): Promise<McpClientHandle> => {
      void server;
      const tools = setup.toolsByPlugin[pluginId] ?? [];
      return {
        listTools: async () => tools,
        callTool: async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
          setup.calls.push({ name, args });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ status: "executed", result: setup.resultByTool[name] ?? { ok: true }, artifacts: [] })
            }]
          };
        },
        close: async () => undefined
      };
    }
  });
  return { manager, setup };
}

async function installPlugin(pluginsDir: string, id: string, manifest: Record<string, unknown> = {}): Promise<void> {
  const dir = path.join(pluginsDir, id);
  await mkdir(path.join(dir, ".codex-plugin"), { recursive: true });
  await writeFile(
    path.join(dir, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: id, version: "0.1.0", ...manifest }),
    "utf8"
  );
  await writeFile(path.join(dir, ".mcp.json"), JSON.stringify({
    mcpServers: { [id]: { command: "node", args: ["./dist/bin/fake.js"] } }
  }), "utf8");
}

function tool(name: string, manifestId: string, overrides: Partial<Tool> = {}): Tool {
  return {
    name,
    title: name,
    description: `${name} description`,
    inputSchema: { type: "object", properties: {} },
    _meta: { manifestId, risk: "medium", toolClass: "perception" },
    ...overrides
  };
}

function context(): ToolContext {
  return {
    runId: "cache-test",
    permissionMode: "auto",
    actionLevel: "sandbox",
    sandboxRoot: "runtime/sandbox",
    workspaceRoot: "."
  };
}

describe("plugin tool caching with host opt-in policy", () => {
  it("keeps a newly installed plugin tool cache-disabled until the host policy enables it", async () => {
    const { manager, setup } = await setupPluginManager();
    setup.toolsByPlugin["demo"] = [tool("secops_demo_query", "demo.query")];
    setup.resultByTool["secops_demo_query"] = { items: [1, 2] };
    await installPlugin(setup.pluginsDir, "demo");
    await manager.load();

    const manifest = setup.registry.manifests().find((m) => m.id === "demo.query");
    expect(manifest?.resultCache).toBeUndefined();

    await setup.registry.executeApiTool("secops_demo_query", "call-1", {}, context());
    await setup.registry.executeApiTool("secops_demo_query", "call-2", {}, context());
    expect(setup.calls).toHaveLength(2);

    await manager.disconnectAll();
  });

  it("caches only when the persisted host policy enables the read-only tool, honoring TTL and args", async () => {
    const { manager, setup } = await setupPluginManager();
    setup.toolsByPlugin["demo"] = [tool("secops_demo_query", "demo.query")];
    setup.resultByTool["secops_demo_query"] = { items: [1, 2] };
    await installPlugin(setup.pluginsDir, "demo");
    setup.cachePolicies.set("demo.query", { enabled: true, ttlMs: 60_000 });
    await manager.load();

    const manifest = setup.registry.manifests().find((m) => m.id === "demo.query");
    expect(manifest?.resultCache).toMatchObject({ version: "plugin:demo:gen1", dataSource: "demo", ttlMs: 60_000, namespace: "plugin:demo" });

    await setup.registry.executeApiTool("secops_demo_query", "call-1", { q: "a" }, context());
    await setup.registry.executeApiTool("secops_demo_query", "call-2", { q: "a" }, context());
    expect(setup.calls).toHaveLength(1);

    await setup.registry.executeApiTool("secops_demo_query", "call-3", { q: "b" }, context());
    expect(setup.calls).toHaveLength(2);
    expect(setup.registry.cacheStats().size).toBe(2);

    await manager.disconnectAll();
  });

  it("reload bumps the generation so old results are unreachable and reclaimed immediately", async () => {
    const { manager, setup } = await setupPluginManager();
    setup.toolsByPlugin["demo"] = [tool("secops_demo_query", "demo.query")];
    setup.resultByTool["secops_demo_query"] = { items: [1, 2] };
    await installPlugin(setup.pluginsDir, "demo");
    setup.cachePolicies.set("demo.query", { enabled: true, ttlMs: 60_000 });
    await manager.load();

    await setup.registry.executeApiTool("secops_demo_query", "call-1", {}, context());
    await setup.registry.executeApiTool("secops_demo_query", "call-2", {}, context());
    expect(setup.calls).toHaveLength(1);
    expect(setup.registry.cacheStats().size).toBe(1);

    await manager.reload();

    // 旧 generation 条目被立即回收，而不是等到容量/TTL 逐出
    expect(setup.registry.cacheStats().size).toBe(0);

    await setup.registry.executeApiTool("secops_demo_query", "call-3", {}, context());
    expect(setup.calls).toHaveLength(2);

    const manifest = setup.registry.manifests().find((m) => m.id === "demo.query");
    expect(manifest?.resultCache?.version).toBe("plugin:demo:gen2");

    await manager.disconnectAll();
  });

  it("lets any successfully executed plugin action globally invalidate cached reads", async () => {
    const { manager, setup } = await setupPluginManager();
    setup.toolsByPlugin["demo"] = [
      tool("secops_demo_query", "demo.query"),
      tool("secops_demo_action", "demo.action", {
        _meta: { manifestId: "demo.action", risk: "low", toolClass: "action", deferLoading: true }
      })
    ];
    setup.resultByTool["secops_demo_query"] = { items: [1, 2] };
    setup.resultByTool["secops_demo_action"] = { ok: true };
    await installPlugin(setup.pluginsDir, "demo");
    setup.cachePolicies.set("demo.query", { enabled: true, ttlMs: 60_000 });
    await manager.load();

    await setup.registry.executeApiTool("secops_demo_query", "call-1", {}, context());
    await setup.registry.executeApiTool("secops_demo_query", "call-2", {}, context());
    expect(setup.calls).toHaveLength(1);

    const actionRecord = await setup.registry.executeApiTool("secops_demo_action", "call-action", {}, context());
    expect(actionRecord.invocation.status).toBe("executed");
    expect(actionRecord.metrics.invalidatedEntries).toBe(1);

    await setup.registry.executeApiTool("secops_demo_query", "call-3", {}, context());
    expect(setup.calls).toHaveLength(3);

    await manager.disconnectAll();
  });

  it("rejects a cache policy for an action tool and for a non-read-only annotated tool", async () => {
    const { manager, setup } = await setupPluginManager();
    setup.toolsByPlugin["demo"] = [
      tool("secops_demo_action", "demo.action", {
        _meta: { manifestId: "demo.action", risk: "low", toolClass: "action" }
      }),
      tool("secops_demo_write", "demo.write", {
        _meta: { manifestId: "demo.write", risk: "low", toolClass: "perception", readOnlyHint: false }
      }),
      tool("secops_demo_read", "demo.read", {
        _meta: { manifestId: "demo.read", risk: "low", toolClass: "perception", readOnlyHint: true }
      })
    ];
    await installPlugin(setup.pluginsDir, "demo");
    setup.cachePolicies.set("demo.action", { enabled: true, ttlMs: 60_000 });
    setup.cachePolicies.set("demo.write", { enabled: true, ttlMs: 60_000 });
    setup.cachePolicies.set("demo.read", { enabled: true, ttlMs: 60_000 });
    await manager.load();

    const manifests = new Map(setup.registry.manifests().map((m) => [m.id, m]));
    // action 与显式非只读工具：unsafe 策略被拒绝，不注入缓存
    expect(manifests.get("demo.action")?.resultCache).toBeUndefined();
    expect(manifests.get("demo.write")?.resultCache).toBeUndefined();
    // readOnly 注解本身不自动启用缓存，但 host 策略显式启用时允许
    expect(manifests.get("demo.read")?.resultCache).toMatchObject({ version: "plugin:demo:gen1" });

    await manager.disconnectAll();
  });

  it("keeps host-generated cache identity free of secrets", async () => {
    const { manager, setup } = await setupPluginManager();
    setup.toolsByPlugin["demo"] = [tool("secops_demo_query", "demo.query")];
    setup.resultByTool["secops_demo_query"] = { items: [1, 2] };
    await installPlugin(setup.pluginsDir, "demo");
    setup.cachePolicies.set("demo.query", { enabled: true, ttlMs: 60_000 });
    await manager.load();

    const secret = "sk-super-secret-key";
    const manifest = setup.registry.manifests().find((m) => m.id === "demo.query");
    const serialized = JSON.stringify(manifest?.resultCache ?? {});
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("authorization");

    const record = await setup.registry.executeApiTool("secops_demo_query", "call-1", {}, context());
    expect(JSON.stringify(record.invocation.cache ?? {})).not.toContain(secret);

    await manager.disconnectAll();
  });
});
