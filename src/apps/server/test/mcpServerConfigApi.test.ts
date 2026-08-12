import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { buildServer } from "../src/app.js";
import type { McpClientHandle, ResolvedMcpConnection } from "../src/mcp/externalMcp.js";
import { testConfig } from "./fixtures/testConfig.js";

function fakeClient(
  server: ResolvedMcpConnection,
  connected: ResolvedMcpConnection[],
  closed: string[]
): McpClientHandle {
  connected.push(server);
  const tools: Tool[] = [{
    name: "remote_read",
    title: "Remote Read",
    description: "Read remote data.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    _meta: { manifestId: "shared.remote_read" }
  }];
  return {
    listTools: async () => tools,
    callTool: async (_name: string, _args: Record<string, unknown>): Promise<CallToolResult> => ({
      content: [{ type: "text", text: JSON.stringify({ result: { ok: true } }) }]
    }),
    close: async () => {
      closed.push(server.name);
    }
  };
}

describe("standalone MCP server config API", () => {
  it("persists, redacts, connects, toggles, reconnects, and removes a stdio server", async () => {
    const config = testConfig();
    const connected: ResolvedMcpConnection[] = [];
    const closed: string[] = [];
    const app = buildServer(config, {
      createStandaloneMcpClient: async (server) => fakeClient(server, connected, closed)
    });

    const initial = await app.inject({ method: "GET", url: "/api/mcp/servers" });
    expect(initial.json()).toEqual({ servers: [] });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      payload: { name: "Broken", transport: "stdio" }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toMatch(/command/);
    const invalidTransport = await app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      payload: { name: "Broken", transport: "sse", url: "https://mcp.example.test" }
    });
    expect(invalidTransport.statusCode).toBe(400);
    expect(invalidTransport.json().error).toMatch(/transport/);

    const created = await app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      payload: {
        name: "Local MCP",
        transport: "stdio",
        command: "node",
        args: ["server.js"],
        cwd: "runtime/mcp",
        env: { SECRET_TOKEN: "top-secret" },
        enabled: true
      }
    });
    expect(created.statusCode).toBe(200);
    const server = created.json().servers[0];
    expect(server).toMatchObject({
      name: "Local MCP",
      transport: "stdio",
      status: "connected",
      toolCount: 1,
      envKeys: ["SECRET_TOKEN"]
    });
    expect(JSON.stringify(server)).not.toContain("top-secret");
    expect(JSON.parse(readFileSync(config.mcpConfigPath, "utf8")).servers[0].env.SECRET_TOKEN).toBe("top-secret");
    expect(connected[0]).toMatchObject({ transport: "stdio", command: "node", args: ["server.js"] });

    const tools = await app.inject({ method: "GET", url: "/api/tools" });
    const externalTool = tools.json().tools.find((tool: { id: string }) => tool.id === `mcp.${server.id}.remote_read`);
    expect(externalTool).toMatchObject({ toolClass: "perception", risk: "low" });
    expect(externalTool.id).toBe(`mcp.${server.id}.remote_read`);

    const reloadedPlugins = await app.inject({ method: "POST", url: "/api/plugins/reload" });
    expect(reloadedPlugins.statusCode).toBe(200);
    const toolsAfterPluginReload = await app.inject({ method: "GET", url: "/api/tools" });
    expect(toolsAfterPluginReload.json().tools.some((tool: { id: string }) => tool.id === externalTool.id)).toBe(true);

    const reconnected = await app.inject({ method: "POST", url: `/api/mcp/servers/${server.id}/reconnect` });
    expect(reconnected.json().servers[0].status).toBe("connected");
    expect(connected).toHaveLength(2);
    expect(closed).toEqual(["Local MCP"]);

    const disabled = await app.inject({
      method: "PUT",
      url: `/api/mcp/servers/${server.id}`,
      payload: { enabled: false }
    });
    expect(disabled.json().servers[0]).toMatchObject({ enabled: false, status: "disabled", toolCount: 0 });
    const disabledTools = await app.inject({ method: "GET", url: "/api/tools" });
    expect(disabledTools.json().tools.some((tool: { id: string }) => tool.id === externalTool.id)).toBe(false);

    const removed = await app.inject({ method: "DELETE", url: `/api/mcp/servers/${server.id}` });
    expect(removed.json()).toEqual({ servers: [] });
    expect(JSON.parse(readFileSync(config.mcpConfigPath, "utf8"))).toEqual({ servers: [] });

    await app.close();
  });

  it("supports Streamable HTTP headers without returning their values", async () => {
    const config = testConfig();
    const connected: ResolvedMcpConnection[] = [];
    const app = buildServer(config, {
      createStandaloneMcpClient: async (server) => fakeClient(server, connected, [])
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      payload: {
        name: "Remote MCP",
        transport: "streamable-http",
        url: "https://mcp.example.test/api",
        headers: { Authorization: "Bearer secret" }
      }
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().servers[0]).toMatchObject({
      status: "connected",
      url: "https://mcp.example.test/api",
      headerNames: ["Authorization"]
    });
    expect(JSON.stringify(created.json())).not.toContain("Bearer secret");
    expect(connected[0]).toMatchObject({
      transport: "streamable-http",
      headers: { Authorization: "Bearer secret" }
    });

    await app.close();
  });

  it("reloads externally edited mcp.json and reports connection errors as server state", async () => {
    const config = testConfig();
    const app = buildServer(config, {
      createStandaloneMcpClient: async (server) => {
        if (server.name === "Failing MCP") {
          throw new Error("connection refused");
        }
        return fakeClient(server, [], []);
      }
    });
    await app.inject({ method: "GET", url: "/api/mcp/servers" });
    writeFileSync(config.mcpConfigPath, JSON.stringify({
      servers: [{
        id: "file-server",
        name: "Failing MCP",
        transport: "stdio",
        enabled: true,
        command: "node",
        args: ["missing.js"]
      }]
    }), "utf8");

    const reloaded = await app.inject({ method: "POST", url: "/api/mcp/servers/reload" });
    expect(reloaded.statusCode).toBe(200);
    expect(reloaded.json().servers[0]).toMatchObject({
      id: "file-server",
      status: "error",
      error: "connection refused"
    });

    await app.close();
  });
});
