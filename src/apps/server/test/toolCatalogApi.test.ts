import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/app.js";
import type { McpClientHandle, ResolvedMcpServer } from "../src/plugins/pluginManager.js";
import { testConfig, scriptedModelForRequest } from "./fixtures/testConfig.js";
import { streamResultFromGenerateResult } from "./fixtures/scriptedModel.js";

/** 在测试 pluginsDir 下创建假插件目录（manifest + .mcp.json，client 由注入提供）。 */
async function installFakePlugin(pluginsDir: string, id: string, name: string): Promise<void> {
  const dir = path.join(pluginsDir, id);
  await mkdir(path.join(dir, ".codex-plugin"), { recursive: true });
  await writeFile(
    path.join(dir, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name, version: "1.0.0", description: "Fake plugin for catalog tests" }),
    "utf8"
  );
  await writeFile(path.join(dir, ".mcp.json"), JSON.stringify({
    mcpServers: { [id]: { command: "node", args: ["./dist/bin/fake.js"] } }
  }), "utf8");
}

function fakePluginClient(pluginId: string): McpClientHandle {
  const tools: Tool[] = pluginId === "wazuh-demo"
    ? [
        {
          name: "secops_wazuh_alerts_search",
          title: "Wazuh Alerts Search",
          description: "Search Wazuh alerts.",
          inputSchema: { type: "object", properties: { query: { type: "string" } } },
          annotations: { readOnlyHint: true },
          _meta: {
            manifestId: "wazuh.alerts.search",
            risk: "low",
            toolClass: "perception",
            deferLoading: true
          }
        },
        {
          name: "secops_wazuh_block_ip",
          title: "Wazuh Block IP",
          description: "Block an IP via Active Response.",
          inputSchema: { type: "object", properties: { ip: { type: "string" } }, required: ["ip"] },
          annotations: { destructiveHint: true },
          _meta: {
            manifestId: "wazuh.block_ip",
            risk: "high",
            toolClass: "action",
            deferLoading: true
          }
        }
      ]
    : [
        {
          name: "secops_shuffle_workflow_list",
          title: "Shuffle Workflow List",
          description: "List Shuffle workflows.",
          inputSchema: { type: "object", properties: {} },
          _meta: {
            manifestId: "shuffle.workflow.list",
            risk: "low",
            toolClass: "perception",
            deferLoading: true
          }
        }
      ];
  return {
    listTools: async () => tools,
    callTool: async (_name: string, _args: Record<string, unknown>): Promise<CallToolResult> => ({
      content: [{ type: "text", text: JSON.stringify({ status: "executed", result: { ok: true } }) }]
    }),
    close: async () => undefined
  };
}

function createPluginClient(_server: ResolvedMcpServer, pluginId: string): Promise<McpClientHandle> {
  return Promise.resolve(fakePluginClient(pluginId));
}

/** 序列模型：按给定动作序列逐步生成（null=返回文本结束当前阶段；对象=调用工具并携带参数）。 */
function createSequencedModel(actions: Array<{ tool: string; input?: Record<string, unknown> } | null>): import("ai").LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test-provider",
    modelId: "sequenced-test-model",
    supportedUrls: {},
    step: 0,
    async doGenerate(): Promise<import("@ai-sdk/provider").LanguageModelV3GenerateResult> {
      this.step += 1;
      const action = actions[this.step - 1];
      if (action) {
        return {
          content: [{
            type: "tool-call",
            toolCallId: `call_${this.step}`,
            toolName: action.tool,
            input: JSON.stringify(action.input ?? {})
          }],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: { inputTokens: { total: 20, noCache: 20, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 10, text: 10, reasoning: undefined } },
          warnings: []
        };
      }
      return {
        content: [{ type: "text", text: "Plugin approval flow completed." }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 20, noCache: 20, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 10, text: 10, reasoning: undefined } },
        warnings: []
      };
    },
    async doStream(options: import("@ai-sdk/provider").LanguageModelV3CallOptions): Promise<import("@ai-sdk/provider").LanguageModelV3StreamResult> {
      return streamResultFromGenerateResult(await this.doGenerate(options));
    }
  } as unknown as import("ai").LanguageModel;
}

describe("tool catalog API with plugins", () => {
  it("exposes plugin tools with manifest metadata", async () => {
    const config = testConfig();
    await installFakePlugin(config.pluginsDir, "wazuh-demo", "Wazuh Demo");
    const app = buildServer(config, { createPluginClient });

    const toolsResponse = await app.inject({ method: "GET", url: "/api/tools" });
    expect(toolsResponse.statusCode).toBe(200);
    const pluginTools = toolsResponse.json().tools.filter((tool: { id: string }) => tool.id.startsWith("wazuh."));
    expect(pluginTools.map((tool: { id: string }) => tool.id)).toEqual(["wazuh.alerts.search", "wazuh.block_ip"]);
    expect(pluginTools.find((tool: { id: string }) => tool.id === "wazuh.block_ip")).toMatchObject({
      toolClass: "action",
      risk: "high",
      deferLoading: true
    });
    expect(pluginTools.find((tool: { id: string }) => tool.id === "wazuh.alerts.search")).toMatchObject({
      toolClass: "perception",
      risk: "low",
      deferLoading: true
    });

    const pluginsResponse = await app.inject({ method: "GET", url: "/api/plugins" });
    expect(pluginsResponse.json().plugins).toEqual([
      expect.objectContaining({ id: "wazuh-demo", name: "Wazuh Demo", version: "1.0.0", status: "loaded", toolCount: 2 })
    ]);

    const mcpServersResponse = await app.inject({ method: "GET", url: "/api/mcp/servers" });
    expect(mcpServersResponse.json().servers).toEqual([
      expect.objectContaining({
        id: "plugin:wazuh-demo:wazuh-demo",
        name: "wazuh-demo",
        transport: "stdio",
        status: "connected",
        toolCount: 2,
        source: "plugin",
        pluginId: "wazuh-demo",
        command: "node"
      })
    ]);

    const blockedUpdate = await app.inject({
      method: "PUT",
      url: "/api/mcp/servers/plugin:wazuh-demo:wazuh-demo",
      payload: { enabled: false }
    });
    expect(blockedUpdate.statusCode).toBe(400);

    await app.close();
  });

  it("exposes plugin streamable-http servers in the MCP server API", async () => {
    const config = testConfig();
    await installFakePlugin(config.pluginsDir, "http-demo", "HTTP Demo");
    await writeFile(path.join(config.pluginsDir, "http-demo", ".mcp.json"), JSON.stringify({
      mcpServers: {
        "http-demo": {
          type: "http",
          url: "http://127.0.0.1:1110/mcp"
        }
      }
    }), "utf8");
    const app = buildServer(config, { createPluginClient });

    const response = await app.inject({ method: "GET", url: "/api/mcp/servers" });
    expect(response.json().servers).toEqual([
      expect.objectContaining({
        id: "plugin:http-demo:http-demo",
        name: "http-demo",
        transport: "streamable-http",
        status: "connected",
        toolCount: 1,
        url: "http://127.0.0.1:1110/mcp",
        source: "plugin",
        pluginId: "http-demo",
        headerNames: []
      })
    ]);

    await app.close();
  });

  it("picks up newly installed plugins after a reload without restarting", async () => {
    const config = testConfig();
    const app = buildServer(config, { createPluginClient });

    const empty = await app.inject({ method: "GET", url: "/api/plugins" });
    expect(empty.json().plugins).toEqual([]);

    // 安装第二个插件后 reload，无需重启服务即可 reach
    await installFakePlugin(config.pluginsDir, "shuffle-demo", "Shuffle Demo");
    const reloaded = await app.inject({ method: "POST", url: "/api/plugins/reload" });
    expect(reloaded.statusCode).toBe(200);
    expect(reloaded.json().plugins).toEqual([
      expect.objectContaining({ id: "shuffle-demo", name: "Shuffle Demo", status: "loaded", toolCount: 1 })
    ]);

    const toolsResponse = await app.inject({ method: "GET", url: "/api/tools" });
    const pluginTools = toolsResponse.json().tools.filter((tool: { id: string }) => tool.id.startsWith("shuffle."));
    expect(pluginTools.map((tool: { id: string }) => tool.id)).toEqual(["shuffle.workflow.list"]);

    await app.close();
  });

  it("reapplies persisted visibility when a plugin is installed after startup", async () => {
    const config = testConfig();
    await writeFile(config.toolVisibilityPath, JSON.stringify({
      "shuffle.workflow.list": false
    }), "utf8");
    const app = buildServer(config, { createPluginClient });

    const empty = await app.inject({ method: "GET", url: "/api/plugins" });
    expect(empty.json().plugins).toEqual([]);

    await installFakePlugin(config.pluginsDir, "shuffle-demo", "Shuffle Demo");
    const reloaded = await app.inject({ method: "POST", url: "/api/plugins/reload" });
    expect(reloaded.statusCode).toBe(200);

    const tools = await app.inject({ method: "GET", url: "/api/tools" });
    expect(tools.json().tools.find((tool: { id: string }) => tool.id === "shuffle.workflow.list").deferLoading).toBe(false);

    await app.close();
  });

  it("persists visibility overrides and applies them to layered routing", async () => {
    const config = testConfig();
    await installFakePlugin(config.pluginsDir, "wazuh-demo", "Wazuh Demo");
    const app = buildServer(config, {
      createModel: () => createSequencedModel([
        { tool: "secops_wazuh_alerts_search" },
        null,
        null
      ]),
      createPluginClient
    });

    const initialTools = await app.inject({ method: "GET", url: "/api/tools" });
    expect(initialTools.json().tools.find((tool: { id: string }) => tool.id === "wazuh.alerts.search").deferLoading).toBe(true);

    const invalid = await app.inject({
      method: "PUT",
      url: "/api/tools/visibility/wazuh.alerts.search",
      payload: { deferLoading: "false" }
    });
    expect(invalid.statusCode).toBe(400);

    const missing = await app.inject({
      method: "PUT",
      url: "/api/tools/visibility/missing.tool",
      payload: { deferLoading: false }
    });
    expect(missing.statusCode).toBe(404);

    const updated = await app.inject({
      method: "PUT",
      url: "/api/tools/visibility/wazuh.alerts.search",
      payload: { deferLoading: false }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().visibility).toEqual({ "wazuh.alerts.search": false });

    const overriddenTools = await app.inject({ method: "GET", url: "/api/tools" });
    expect(overriddenTools.json().tools.find((tool: { id: string }) => tool.id === "wazuh.alerts.search").deferLoading).toBe(false);

    const run = await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: {
        messages: [{ role: "user", content: "use the configured triage tool" }],
        permissionMode: "auto"
      }
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().toolInvocations).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolName: "wazuh.alerts.search", status: "executed" })
    ]));

    const visibility = await app.inject({ method: "GET", url: "/api/tools/visibility" });
    expect(visibility.json()).toEqual({ visibility: { "wazuh.alerts.search": false } });

    const cleared = await app.inject({ method: "DELETE", url: "/api/tools/visibility/wazuh.alerts.search" });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toEqual({ visibility: {} });

    const restoredTools = await app.inject({ method: "GET", url: "/api/tools" });
    expect(restoredTools.json().tools.find((tool: { id: string }) => tool.id === "wazuh.alerts.search").deferLoading).toBe(true);
    const clearedAgain = await app.inject({ method: "DELETE", url: "/api/tools/visibility/wazuh.alerts.search" });
    expect(clearedAgain.statusCode).toBe(404);

    await app.close();
  });

  it("routes plugin action tools through layered routing and approval", async () => {
    const config = testConfig();
    await installFakePlugin(config.pluginsDir, "wazuh-demo", "Wazuh Demo");
    const app = buildServer(config, {
      // 序列模型：triage 调 core 工具后结束，deep 调插件 action 工具后结束
      createModel: (_connection, _request) => createSequencedModel([
        { tool: "secops_ioc_enrich" },
        null,
        { tool: "secops_wazuh_block_ip", input: { ip: "203.0.113.10" } },
        null
      ]),
      createPluginClient
    });

    // triage 阶段模型只能看到 core 工具；deep 阶段经关键词推断加载 wazuh-platform，
    // 插件 action 工具 wazuh.block_ip 在 sandbox+ask 下必须走审批（全局 ask：所有 action 均审批）
    const run = await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: {
        messages: [{ role: "user", content: "wazuh block 203.0.113.10" }],
        permissionMode: "ask"
      }
    });
    expect(run.statusCode).toBe(200);
    const result = run.json();
    expect(result.status).toBe("needs_approval");
    expect(result.toolInvocations.some((tool: { toolName: string; status: string }) =>
      tool.toolName === "wazuh.block_ip" && tool.status === "pending_approval"
    )).toBe(true);

    // 拒绝该审批 → 无副作用
    const approvals = await app.inject({ method: "GET", url: "/api/approvals" });
    const pending = approvals.json().approvals.find(
      (approval: { apiName: string }) => approval.apiName === "secops_wazuh_block_ip"
    );
    expect(pending).toBeDefined();
    const denied = await app.inject({ method: "POST", url: `/api/approvals/${pending.id}/deny` });
    expect(denied.statusCode).toBe(200);
    expect(denied.json().invocation.status).toBe("denied");

    await app.close();
  });

  it("reports plugin load errors without failing the service", async () => {
    const config = testConfig();
    // 无 manifest 的目录：加载失败只标记 error
    await mkdir(path.join(config.pluginsDir, "broken-plugin"), { recursive: true });
    const app = buildServer(config, { createPluginClient });

    const pluginsResponse = await app.inject({ method: "GET", url: "/api/plugins" });
    expect(pluginsResponse.json().plugins).toEqual([
      expect.objectContaining({
        id: "broken-plugin",
        status: "error",
        error: expect.stringContaining("Missing plugin manifest")
      })
    ]);

    // 服务其他路由不受影响
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);

    await app.close();
  });

  it("auto mode gates high risk plugin actions by default and executes after toggling autoApproveHighRisk", async () => {
    const config = testConfig();
    await installFakePlugin(config.pluginsDir, "wazuh-demo", "Wazuh Demo");
    const app = buildServer(config, { createPluginClient });

    // 默认 autoApproveHighRisk=true：auto 请求下高危 action 仍走审批
    const before = await app.inject({
      method: "POST",
      url: "/api/mcp/tools/secops_wazuh_block_ip/call",
      payload: {
        permissionMode: "auto",
        args: { ip: "203.0.113.10" }
      }
    });
    expect(before.json().invocation.status).toBe("pending_approval");

    // 关闭高危开关后同一请求直接执行（运行时热更新，无需重启）
    const toggle = await app.inject({
      method: "PUT",
      url: "/api/settings/auto-approve-high-risk",
      payload: { autoApproveHighRisk: false }
    });
    expect(toggle.statusCode).toBe(200);
    expect(toggle.json().autoApproveHighRisk).toBe(false);

    const after = await app.inject({
      method: "POST",
      url: "/api/mcp/tools/secops_wazuh_block_ip/call",
      payload: {
        permissionMode: "auto",
        args: { ip: "203.0.113.10" }
      }
    });
    expect(after.json().invocation.status).toBe("executed");

    await app.close();
  });
});
