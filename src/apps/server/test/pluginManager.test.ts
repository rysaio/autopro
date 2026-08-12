import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { PluginManager, type McpClientHandle, type ResolvedMcpServer } from "../src/plugins/pluginManager.js";
import { ToolRegistry } from "../src/tools/registry.js";

interface FakePluginSetup {
  pluginsDir: string;
  registry: ToolRegistry;
  spawned: ResolvedMcpServer[];
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  toolsByPlugin: Record<string, Tool[]>;
  toolsByServer: Record<string, Tool[]>;
  resultByTool: Record<string, unknown>;
}

async function setupPluginManager(env: NodeJS.ProcessEnv = {}): Promise<{ manager: PluginManager; setup: FakePluginSetup }> {
  const pluginsDir = await mkdtemp(path.join(os.tmpdir(), "secops-plugin-"));
  const registry = new ToolRegistry();
  const setup: FakePluginSetup = {
    pluginsDir,
    registry,
    spawned: [],
    calls: [],
    toolsByPlugin: {},
    toolsByServer: {},
    resultByTool: {}
  };
  const manager = new PluginManager({
    pluginsDir,
    registry,
    env,
    createClient: async (server: ResolvedMcpServer, pluginId: string): Promise<McpClientHandle> => {
      setup.spawned.push(server);
      const tools = setup.toolsByServer[server.name] ?? setup.toolsByPlugin[pluginId] ?? [];
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

describe("PluginManager", () => {
  it("loads every MCP server declared by a plugin", async () => {
    const { manager, setup } = await setupPluginManager();
    setup.toolsByServer["first"] = [tool("secops_first_query", "multi.first")];
    setup.toolsByServer["second"] = [tool("secops_second_query", "multi.second")];
    await installPlugin(setup.pluginsDir, "multi");
    await writeFile(path.join(setup.pluginsDir, "multi", ".mcp.json"), JSON.stringify({
      mcpServers: {
        first: { command: "node", args: ["first.js"] },
        second: { command: "node", args: ["second.js"] }
      }
    }), "utf8");

    await manager.load();

    expect(setup.spawned.map((server) => server.name)).toEqual(["first", "second"]);
    expect(setup.registry.manifests().map((manifest) => manifest.id)).toEqual(
      expect.arrayContaining(["multi.first", "multi.second"])
    );
    expect(manager.status()[0]).toMatchObject({
      status: "loaded",
      toolCount: 2,
      mcpServers: [
        { name: "first", status: "loaded", toolCount: 1 },
        { name: "second", status: "loaded", toolCount: 1 }
      ]
    });

    await manager.disconnectAll();
  });

  it("keeps tools from healthy MCP servers when another server conflicts", async () => {
    const { manager, setup } = await setupPluginManager();
    setup.toolsByServer["healthy"] = [tool("secops_healthy_query", "multi.healthy")];
    setup.toolsByServer["conflict"] = [tool("secops_ioc_enrich", "multi.conflict")];
    await installPlugin(setup.pluginsDir, "multi");
    await writeFile(path.join(setup.pluginsDir, "multi", ".mcp.json"), JSON.stringify({
      mcpServers: {
        healthy: { command: "node", args: ["healthy.js"] },
        conflict: { command: "node", args: ["conflict.js"] }
      }
    }), "utf8");

    await manager.load();

    expect(manager.status()[0]).toMatchObject({
      status: "degraded",
      toolCount: 1,
      mcpServers: [
        { name: "healthy", status: "loaded", toolCount: 1 },
        { name: "conflict", status: "error", toolCount: 0 }
      ]
    });
    expect(setup.registry.manifests().map((manifest) => manifest.id)).toContain("multi.healthy");

    await manager.disconnectAll();
  });

  it("loads a plugin, registers its tools, and spawns with host env injection", async () => {
    const { manager, setup } = await setupPluginManager();
    setup.toolsByPlugin["demo"] = [
      tool("secops_demo_query", "demo.query"),
      tool("secops_demo_action", "demo.action", {
        _meta: { manifestId: "demo.action", risk: "high", toolClass: "action", deferLoading: true }
      })
    ];
    await installPlugin(setup.pluginsDir, "demo");

    await manager.load();

    expect(manager.status()).toEqual([
      expect.objectContaining({ id: "demo", status: "loaded", toolCount: 2 })
    ]);
    const manifestIds = setup.registry.manifests().map((m) => m.id);
    expect(manifestIds).toContain("demo.query");
    expect(manifestIds).toContain("demo.action");
    // 缺失 deferLoading 的插件工具默认按需（deferred），不会因缺少元数据而变成常驻。
    expect(setup.registry.manifests().find((manifest) => manifest.id === "demo.query")?.deferLoading).toBe(true);
    expect(setup.registry.manifests().find((manifest) => manifest.id === "demo.action")?.deferLoading).toBe(true);

    // spawn env：透传宿主环境 + 插件放行 + 动作审批归主服务
    expect(setup.spawned).toHaveLength(1);
    expect(setup.spawned[0]?.transport).toBe("stdio");
    if (setup.spawned[0]?.transport === "stdio") {
      expect(setup.spawned[0].cwd).toBe(path.join(setup.pluginsDir, "demo"));
      expect(setup.spawned[0].env.SECOPS_ACTION_LEVEL).toBe("full-access");
      expect(setup.spawned[0].env.WAZUH_MCP_ALLOW_ACTIONS).toBe("true");
      expect(setup.spawned[0].env.SHUFFLE_MCP_ALLOW_ACTIONS).toBe("true");
    }

    await manager.disconnectAll();
  });

  it("connects plugin MCP servers over streamable-http and resolves auth headers", async () => {
    const { manager, setup } = await setupPluginManager({
      DROPLINKED_MCP_API_KEY: "secret-key",
      GITHUB_PAT_TOKEN: "gh-token"
    });
    setup.toolsByServer["droplinked"] = [tool("secops_droplinked_search", "droplinked.search")];
    await installPlugin(setup.pluginsDir, "droplinked");
    await writeFile(path.join(setup.pluginsDir, "droplinked", ".mcp.json"), JSON.stringify({
      mcpServers: {
        droplinked: {
          type: "http",
          url: "https://mcp.droplinked.com/mcp",
          headers: {
            "X-MCP-API-Key": "${DROPLINKED_MCP_API_KEY}",
            "X-Static": "ok"
          },
          bearer_token_env_var: "GITHUB_PAT_TOKEN"
        }
      }
    }), "utf8");

    await manager.load();

    expect(setup.spawned).toHaveLength(1);
    expect(setup.spawned[0]?.transport).toBe("streamable-http");
    if (setup.spawned[0]?.transport === "streamable-http") {
      expect(setup.spawned[0].url).toBe("https://mcp.droplinked.com/mcp");
      expect(setup.spawned[0].headers).toEqual({
        "X-MCP-API-Key": "secret-key",
        "X-Static": "ok",
        Authorization: "Bearer gh-token"
      });
    }
    expect(manager.status()[0]).toMatchObject({
      id: "droplinked",
      status: "loaded",
      toolCount: 1,
      mcpServers: [
        { name: "droplinked", status: "loaded", toolCount: 1 }
      ]
    });

    await manager.disconnectAll();
  });

  it("validates optional routing metadata and plugin keywords into generic routing hints", async () => {
    const { manager, setup } = await setupPluginManager();
    setup.toolsByPlugin["demo"] = [
      tool("secops_demo_query", "demo.query", {
        description: "Search customer records by email address or phone number.",
        _meta: {
          manifestId: "demo.query",
          risk: "low",
          toolClass: "perception",
          routing: { group: "customer-search", keywords: ["customer lookup", "crm search"] },
          tags: ["customer", "crm"]
        }
      }),
      tool("secops_demo_bad", "demo.bad", {
        _meta: {
          manifestId: "demo.bad",
          risk: "low",
          toolClass: "perception",
          routing: { group: 42, keywords: ["", 7] },
          deferLoading: "yes"
        }
      }),
      tool("secops_demo_annotated", "demo.annotated", {
        annotations: { readOnlyHint: true, destructiveHint: false },
        _meta: { manifestId: "demo.annotated", risk: "low", toolClass: "perception", deferLoading: false }
      })
    ];
    await installPlugin(setup.pluginsDir, "demo", {
      keywords: ["demo", "customer-records"],
      routing: { group: "demo-group", keywords: ["demo lookup"] }
    });
    await manager.load();

    const manifests = new Map(setup.registry.manifests().map((m) => [m.id, m]));
    // 合法 per-tool routing 生效；plugin 关键字与 _meta.tags 合并为路由标签。
    expect(manifests.get("demo.query")?.routing).toEqual({
      group: "customer-search",
      keywords: ["customer lookup", "crm search"]
    });
    expect(manifests.get("demo.query")?.tags).toEqual(
      expect.arrayContaining(["demo", "customer-records", "customer", "crm"])
    );
    // 无效 per-tool routing 回退到 plugin 级 routing；无效 deferLoading 回退为按需。
    expect(manifests.get("demo.bad")?.routing).toEqual({
      group: "demo-group",
      keywords: ["demo lookup"]
    });
    expect(manifests.get("demo.bad")?.deferLoading).toBe(true);
    // 显式 deferLoading=false 仍然生效；MCP 注解派生出只读标签。
    expect(manifests.get("demo.annotated")?.deferLoading).toBe(false);
    expect(manifests.get("demo.annotated")?.tags).toContain("read-only");

    await manager.disconnectAll();
  });

  it("forwards tool calls through MCP and parses the plugin result envelope", async () => {
    const { manager, setup } = await setupPluginManager();
    setup.toolsByPlugin["demo"] = [tool("secops_demo_query", "demo.query")];
    setup.resultByTool["secops_demo_query"] = { items: [1, 2, 3] };
    await installPlugin(setup.pluginsDir, "demo");
    await manager.load();

    const record = await setup.registry.executeApiTool("secops_demo_query", "call-1", {}, {
      runId: "plugin-test",
      permissionMode: "auto",
      actionLevel: "sandbox",
      sandboxRoot: "runtime/sandbox",
      workspaceRoot: "."
    });

    expect(record.invocation.status).toBe("executed");
    expect(record.invocation.result).toEqual({ items: [1, 2, 3] });
    expect(setup.calls).toEqual([{ name: "secops_demo_query", args: {} }]);

    await manager.disconnectAll();
  });

  it("reload picks up newly installed plugins and drops removed ones", async () => {
    const { manager, setup } = await setupPluginManager();
    setup.toolsByPlugin["first"] = [tool("secops_first_tool", "first.tool")];
    await installPlugin(setup.pluginsDir, "first");
    await manager.load();
    expect(manager.status()).toHaveLength(1);

    // 安装第二个插件后 reload
    setup.toolsByPlugin["second"] = [tool("secops_second_tool", "second.tool")];
    await installPlugin(setup.pluginsDir, "second");
    await manager.reload();

    expect(manager.status().map((p) => p.id).sort()).toEqual(["first", "second"]);
    expect(setup.registry.manifests().map((m) => m.id)).toEqual(
      expect.arrayContaining(["first.tool", "second.tool"])
    );

    // 删除第二个插件目录后 reload
    await rmPluginDir(setup.pluginsDir, "second");
    await manager.reload();
    expect(manager.status().map((p) => p.id)).toEqual(["first"]);
    expect(setup.registry.manifests().map((m) => m.id)).not.toContain("second.tool");

    await manager.disconnectAll();
  });

  it("isolates a single plugin failure without affecting the service or other plugins", async () => {
    const { manager, setup } = await setupPluginManager();
    // 无 manifest 的目录 → 加载失败
    await mkdir(path.join(setup.pluginsDir, "broken"), { recursive: true });
    setup.toolsByPlugin["healthy"] = [tool("secops_healthy_tool", "healthy.tool")];
    await installPlugin(setup.pluginsDir, "healthy");

    await manager.load();

    const statuses = manager.status();
    expect(statuses).toHaveLength(2);
    expect(statuses.find((p) => p.id === "broken")).toMatchObject({
      status: "error",
      error: expect.stringContaining("Missing plugin manifest")
    });
    expect(statuses.find((p) => p.id === "healthy")).toMatchObject({ status: "loaded" });
    expect(setup.registry.manifests().map((m) => m.id)).toContain("healthy.tool");

    await manager.disconnectAll();
  });

  it("merges concurrent reload calls into one serialized pass without tool conflicts", async () => {
    const { manager, setup } = await setupPluginManager();
    setup.toolsByPlugin["demo"] = [tool("secops_demo_query", "demo.query")];
    await installPlugin(setup.pluginsDir, "demo");
    await manager.load();

    await Promise.all([manager.reload(), manager.reload()]);

    expect(manager.status().map((p) => p.id)).toEqual(["demo"]);
    expect(manager.status()[0]?.status).toBe("loaded");
    expect(setup.registry.manifests().map((m) => m.id)).toContain("demo.query");

    await manager.disconnectAll();
  });

  it("marks a plugin as error when tool registration conflicts", async () => {
    const { manager, setup } = await setupPluginManager();
    // 与内置工具 apiName 冲突
    setup.toolsByPlugin["clash"] = [tool("secops_ioc_enrich", "clash.tool")];
    await installPlugin(setup.pluginsDir, "clash");

    await manager.load();

    expect(manager.status()[0]).toMatchObject({
      id: "clash",
      status: "error",
      error: expect.stringContaining("Duplicate tool apiName")
    });
    expect(setup.registry.manifests()).toHaveLength(12);

    await manager.disconnectAll();
  });
});

async function rmPluginDir(pluginsDir: string, id: string): Promise<void> {
  await mkdir(path.join(pluginsDir, id), { recursive: true });
  // Node 22+ 支持 fs.rm 递归；此处用系统 rm 语义的最小实现
  const { rm } = await import("node:fs/promises");
  await rm(path.join(pluginsDir, id), { recursive: true, force: true });
}
