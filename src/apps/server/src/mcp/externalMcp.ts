import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type {
  ToolClass,
  ToolResultCachePolicy,
  ToolRisk,
  ToolRoutingHints,
  ToolSchema
} from "@secops-agent/shared";
import type { ModelTool } from "../providers/types.js";
import type { SecOpsTool, ToolContext, ToolExecutionResult } from "../tools/types.js";

export interface ResolvedStdioMcpServer {
  transport: "stdio";
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface ResolvedHttpMcpServer {
  transport: "streamable-http";
  name: string;
  url: string;
  headers: Record<string, string>;
}

export type ResolvedMcpConnection = ResolvedStdioMcpServer | ResolvedHttpMcpServer;

const HTTP_MCP_CONNECT_TIMEOUT_MS = 8_000;

export interface McpClientHandle {
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

export async function connectMcpClient(server: ResolvedMcpConnection): Promise<McpClientHandle> {
  const client = new Client({ name: "secops-agent-host", version: "0.1.0" });
  if (server.transport === "stdio") {
    await client.connect(new StdioClientTransport({
      command: server.command,
      args: server.args,
      cwd: server.cwd,
      env: server.env,
      stderr: "pipe"
    }));
  } else {
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers }
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        client.connect(transport as Parameters<Client["connect"]>[0]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(
            `MCP HTTP connection timed out after ${HTTP_MCP_CONNECT_TIMEOUT_MS}ms`
          )), HTTP_MCP_CONNECT_TIMEOUT_MS);
        })
      ]);
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    listTools: async () => (await client.listTools()).tools,
    callTool: async (name, args): Promise<CallToolResult> => (
      await client.callTool({ name, arguments: args }) as CallToolResult
    ),
    close: async () => client.close()
  };
}

export interface ExternalMcpToolOptions {
  sourceId: string;
  apiName?: string;
  manifestId?: string;
  tags?: string[];
  useRemoteManifestId?: boolean;
  /** Validated generic routing hints; missing values fall back to derived hints. */
  routing?: ToolRoutingHints;
  /** Host-owned opt-in result cache policy; missing means disabled. */
  resultCache?: ToolResultCachePolicy;
}

export function externalMcpTool(
  options: ExternalMcpToolOptions,
  tool: Tool,
  call: (args: Record<string, unknown>) => Promise<CallToolResult>
): SecOpsTool {
  const meta = tool._meta ?? {};
  const manifestId = options.manifestId
    ?? (options.useRemoteManifestId !== false && typeof meta.manifestId === "string" && meta.manifestId.length > 0
      ? meta.manifestId
      : `${options.sourceId}.${tool.name}`);
  const schema = toToolSchema(tool.inputSchema);
  const toolClass = toToolClass(meta.toolClass, tool);
  return {
    apiName: options.apiName ?? tool.name,
    manifest: {
      id: manifestId,
      name: typeof tool.title === "string" && tool.title.length > 0 ? tool.title : tool.name,
      description: tool.description ?? "",
      toolClass,
      risk: toToolRisk(meta.risk, tool),
      // 缺失/无效的 deferLoading 默认按需（true）：未知外部工具不得因此变成常驻。
      deferLoading: meta.deferLoading !== false,
      inputSchema: schema,
      tags: uniqueStrings([
        ...(options.tags ?? [options.sourceId]),
        ...toValidatedTags(meta.tags),
        ...derivedAnnotationTags(tool)
      ]),
      mcpCompatible: true,
      ...(options.routing ? { routing: options.routing } : {}),
      ...(options.resultCache ? { resultCache: options.resultCache } : {})
    },
    toModelTool(): ModelTool {
      return {
        type: "function",
        function: {
          name: options.apiName ?? tool.name,
          description: tool.description ?? "",
          parameters: schema as unknown as Record<string, unknown>
        }
      };
    },
    async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
      return parseCallResult(await call(args));
    }
  };
}

function parseCallResult(result: CallToolResult): ToolExecutionResult {
  const text = result.content
    .filter((content): content is Extract<typeof content, { type: "text" }> => content.type === "text")
    .map((content) => content.text)
    .join("\n");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      return {
        output: "result" in record ? record.result : record,
        ...(Array.isArray(record.artifacts) ? { artifacts: record.artifacts } : {})
      };
    }
    return { output: parsed };
  } catch {
    return { output: text };
  }
}

function toToolSchema(inputSchema: unknown): ToolSchema {
  if (inputSchema && typeof inputSchema === "object" && !Array.isArray(inputSchema)) {
    const schema = inputSchema as Record<string, unknown>;
    if (schema.type === "object" && schema.properties && typeof schema.properties === "object") {
      const result: ToolSchema = {
        type: "object",
        properties: schema.properties as Record<string, unknown>
      };
      if (Array.isArray(schema.required)) {
        result.required = schema.required.map(String);
      }
      if (typeof schema.additionalProperties === "boolean") {
        result.additionalProperties = schema.additionalProperties;
      }
      return result;
    }
  }
  return { type: "object", properties: {} };
}

function toToolClass(value: unknown, tool: Tool): ToolClass {
  if (value === "perception" || value === "reasoning" || value === "evidence" || value === "action") {
    return value;
  }
  if (tool.annotations?.readOnlyHint === true) {
    return "perception";
  }
  return "action";
}

function toToolRisk(value: unknown, tool: Tool): ToolRisk {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true ? "low" : "high";
}

/** Accepts only non-empty strings; duplicate and malformed entries are dropped. */
function toValidatedTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueStrings(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim()));
}

/** Derives safe routing tags from standard MCP tool annotations (compatible metadata). */
function derivedAnnotationTags(tool: Tool): string[] {
  const meta = tool._meta ?? {};
  const annotations = (tool as { annotations?: Record<string, unknown> }).annotations ?? {};
  const tags: string[] = [];
  if (booleanHint(meta.readOnlyHint ?? annotations.readOnlyHint)) {
    tags.push("read-only");
  }
  if (booleanHint(meta.destructiveHint ?? annotations.destructiveHint)) {
    tags.push("destructive");
  }
  if (booleanHint(meta.openWorldHint ?? annotations.openWorldHint)) {
    tags.push("open-world");
  }
  return tags;
}

function booleanHint(value: unknown): boolean {
  return value === true;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
