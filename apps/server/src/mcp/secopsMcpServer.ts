import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PermissionMode, SkillManifest } from "@secops-agent/shared";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";

export function createSecOpsMcpServer(registry: ToolRegistry, context: ToolContext): McpServer {
  const server = new McpServer({
    name: "secops-agent-tools",
    version: "0.1.0"
  });

  for (const manifest of registry.manifests()) {
    server.registerTool(
      apiNameForManifest(manifest.id),
      {
        title: manifest.name,
        description: manifest.description,
        inputSchema: mcpInputSchemaForManifest(manifest),
        annotations: {
          readOnlyHint: manifest.toolClass !== "action",
          destructiveHint: manifest.id === "full_access.exec",
          idempotentHint: manifest.toolClass !== "action",
          openWorldHint: manifest.id === "full_access.exec"
        },
        _meta: {
          manifestId: manifest.id,
          risk: manifest.risk,
          permission: manifest.defaultPermission
        }
      },
      async (args: Record<string, unknown>) => {
        const record = await registry.executeApiTool(
          apiNameForManifest(manifest.id),
          crypto.randomUUID(),
          args as Record<string, unknown>,
          context
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: record.invocation.status,
                result: record.invocation.result,
                error: record.invocation.error,
                artifacts: record.artifacts
              }, null, 2)
            }
          ] as const
        };
      }
    );
  }

  return server;
}

export function apiNameForManifest(id: string): string {
  return `secops_${id.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
}

export function mcpToolSummaries(registry: ToolRegistry) {
  return registry.manifests().map((manifest) => ({
    name: apiNameForManifest(manifest.id),
    manifest
  }));
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

export function mcpContext(input: {
  runId?: string;
  sessionId?: string;
  permissionMode?: PermissionMode;
  actionLevel: ToolContext["actionLevel"];
  sandboxRoot: string;
  workspaceRoot: string;
}): ToolContext {
  const context: ToolContext = {
    runId: input.runId ?? crypto.randomUUID(),
    permissionMode: input.permissionMode ?? "auto",
    actionLevel: input.actionLevel,
    sandboxRoot: input.sandboxRoot,
    workspaceRoot: input.workspaceRoot
  };
  if (input.sessionId) {
    context.sessionId = input.sessionId;
  }
  return context;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
