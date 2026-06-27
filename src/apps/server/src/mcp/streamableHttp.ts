import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RuntimeSettings } from "@secops-agent/shared";
import type { AppConfig } from "../config.js";
import type { ToolRegistry } from "../tools/registry.js";
import { createSecOpsMcpServer, mcpContext } from "./secopsMcpServer.js";

export function registerStreamableMcpRoutes(
  app: FastifyInstance,
  registry: ToolRegistry,
  config: AppConfig,
  getSettings: () => RuntimeSettings
) {
  app.post("/api/mcp", async (request, reply) => {
    await handleMcpRequest(request, reply, registry, config, getSettings());
  });

  app.get("/api/mcp", async (_request, reply) => methodNotAllowed(reply));
  app.delete("/api/mcp", async (_request, reply) => methodNotAllowed(reply));
}

async function handleMcpRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  registry: ToolRegistry,
  config: AppConfig,
  settings: RuntimeSettings
) {
  const context = mcpContext({
    permissionMode: permissionModeFromHeader(request.headers["x-secops-permission-mode"]) ?? "ask",
    actionLevel: settings.actionLevel,
    sandboxRoot: config.sandboxRoot,
    workspaceRoot: config.workspaceRoot
  });
  const server = createSecOpsMcpServer(registry, context);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);

  reply.hijack();
  try {
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  } catch (error) {
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(500, { "content-type": "application/json" });
      reply.raw.end(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Internal MCP server error"
        },
        id: null
      }));
    }
  } finally {
    await transport.close();
    await server.close();
  }
}

function methodNotAllowed(reply: FastifyReply) {
  return reply
    .code(405)
    .header("Allow", "POST")
    .send({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed."
      },
      id: null
    });
}

function permissionModeFromHeader(value: string | string[] | undefined) {
  const mode = Array.isArray(value) ? value[0] : value;
  if (mode === "auto" || mode === "ask" || mode === "deny") {
    return mode;
  }
  return undefined;
}
