import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createWazuhTools } from "../tools/registry.js";
import type { SkillManifest, WazuhExecutionContext, WazuhPluginTool } from "../tools/types.js";

export interface WazuhMcpServerOptions {
  tools?: WazuhPluginTool[];
  context?: WazuhExecutionContext;
  allowActions?: boolean;
}

export function createWazuhMcpServer(options: WazuhMcpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: "wazuh-secops",
    version: "0.1.0"
  });
  const context = options.context ?? wazuhMcpContextFromEnv();
  const allowActions = options.allowActions ?? process.env.WAZUH_MCP_ALLOW_ACTIONS === "true";
  const tools = options.tools ?? createWazuhTools();

  for (const tool of tools) {
    server.registerTool(
      tool.apiName,
      {
        title: tool.manifest.name,
        description: tool.manifest.description,
        inputSchema: mcpInputSchemaForManifest(tool.manifest),
        annotations: {
          readOnlyHint: tool.manifest.toolClass !== "action",
          destructiveHint: tool.manifest.toolClass === "action",
          idempotentHint: tool.manifest.toolClass !== "action",
          openWorldHint: false
        },
        _meta: {
          manifestId: tool.manifest.id,
          risk: tool.manifest.risk,
          permission: tool.manifest.defaultPermission
        }
      },
      async (args: Record<string, unknown>) => {
        const result = await executeMcpTool(tool, args, context, allowActions);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ] as const
        };
      }
    );
  }

  return server;
}

export function wazuhMcpContextFromEnv(env: NodeJS.ProcessEnv = process.env): WazuhExecutionContext {
  return {
    runId: env.WAZUH_MCP_RUN_ID?.trim() || `wazuh-mcp-${crypto.randomUUID()}`,
    permissionMode: permissionMode(env.WAZUH_MCP_PERMISSION_MODE),
    actionLevel: actionLevel(env.SECOPS_ACTION_LEVEL),
    ...(env.SECOPS_SANDBOX_ROOT ? { sandboxRoot: env.SECOPS_SANDBOX_ROOT } : {}),
    ...(env.SECOPS_WORKSPACE_ROOT ? { workspaceRoot: env.SECOPS_WORKSPACE_ROOT } : {})
  };
}

export function mcpInputSchemaForManifest(manifest: SkillManifest): Record<string, z.ZodType> {
  if (manifest.inputSchema.type !== "object") {
    throw new Error(`Unsupported MCP input schema root for ${manifest.id}`);
  }
  const required = new Set(manifest.inputSchema.required ?? []);
  const shape: Record<string, z.ZodType> = {};

  for (const key of required) {
    if (!isRecord(manifest.inputSchema.properties[key])) {
      throw new Error(`Required MCP input "${key}" is missing from ${manifest.id}`);
    }
  }

  for (const [name, property] of Object.entries(manifest.inputSchema.properties)) {
    if (!isRecord(property)) {
      throw new Error(`Unsupported MCP input schema for "${name}" on ${manifest.id}`);
    }
    const schema = zodForProperty(manifest, name, property);
    shape[name] = required.has(name) ? schema : schema.optional();
  }
  return shape;
}

async function executeMcpTool(
  tool: WazuhPluginTool,
  args: Record<string, unknown>,
  context: WazuhExecutionContext,
  allowActions: boolean
) {
  if (tool.manifest.toolClass === "action" && !allowActions) {
    return {
      status: "denied",
      result: undefined,
      error:
        "Standalone Wazuh MCP does not own approvals. Set WAZUH_MCP_ALLOW_ACTIONS=true and SECOPS_ACTION_LEVEL=full-access to enable action execution.",
      artifacts: []
    };
  }
  if (tool.manifest.toolClass === "action" && context.actionLevel !== "full-access") {
    return {
      status: "denied",
      result: undefined,
      error: `Action tools require full-access in standalone Wazuh MCP. Current action level is ${context.actionLevel}.`,
      artifacts: []
    };
  }

  try {
    const result = await tool.execute(args, context);
    return {
      status: "executed",
      result: result.output,
      artifacts: result.artifacts ?? []
    };
  } catch (error) {
    return {
      status: "failed",
      result: undefined,
      error: error instanceof Error ? error.message : String(error),
      artifacts: []
    };
  }
}

function zodForProperty(manifest: SkillManifest, name: string, property: Record<string, unknown>): z.ZodType {
  const description = typeof property.description === "string" ? property.description : undefined;
  let schema: z.ZodType;

  if (Array.isArray(property.enum)) {
    if (property.enum.length === 0 || property.enum.some((value) => typeof value !== "string")) {
      throw new Error(`Unsupported MCP enum schema for "${name}" on ${manifest.id}`);
    }
    schema = z.enum(property.enum as [string, ...string[]]);
  } else if (property.type === "string") {
    schema = z.string();
  } else if (property.type === "array") {
    const items = property.items;
    if (!isRecord(items) || items.type !== "string") {
      throw new Error(`Unsupported MCP array schema for "${name}" on ${manifest.id}`);
    }
    schema = z.array(z.string());
  } else if (property.type === "number") {
    schema = z.number();
  } else {
    throw new Error(`Unsupported MCP input schema for "${name}" on ${manifest.id}`);
  }

  return description ? schema.describe(description) : schema;
}

function permissionMode(value: string | undefined): WazuhExecutionContext["permissionMode"] {
  return value === "ask" || value === "deny" || value === "auto" ? value : "auto";
}

function actionLevel(value: string | undefined): WazuhExecutionContext["actionLevel"] {
  return value === "sandbox" || value === "full-access" || value === "observe" ? value : "observe";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
