import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { McpServerConfigState, McpServerSummary, McpServerTransport } from "@secops-agent/shared";
import {
  connectMcpClient,
  externalMcpTool,
  type McpClientHandle,
  type ResolvedMcpConnection
} from "../mcp/externalMcp.js";
import { ToolRegistry } from "../tools/registry.js";
import { normalizePortablePath } from "./portablePath.js";

interface McpServerConfig {
  id: string;
  name: string;
  transport: McpServerTransport;
  enabled: boolean;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpServerInput {
  name: string;
  transport: McpServerTransport;
  enabled?: boolean;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpServerUpdate {
  name?: string;
  transport?: McpServerTransport;
  enabled?: boolean;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

interface ConnectionState {
  status: "connected" | "disabled" | "error";
  toolCount: number;
  client?: McpClientHandle;
  error?: string;
}

interface PersistedMcpConfig {
  servers: McpServerConfig[];
}

export interface McpServerManagerOptions {
  filePath: string;
  workspaceRoot: string;
  registry: ToolRegistry;
  env?: NodeJS.ProcessEnv;
  createClient?: (server: ResolvedMcpConnection) => Promise<McpClientHandle>;
}

export class McpServerManager {
  private servers: McpServerConfig[];
  private readonly connections = new Map<string, ConnectionState>();

  constructor(private readonly options: McpServerManagerOptions) {
    this.servers = this.readConfig();
  }

  async load(): Promise<McpServerConfigState> {
    // 每个独立 MCP server 使用互不相同的 sourceId，可安全并行连接以缩短冷启动时间。
    await Promise.all(this.servers.map((server) => this.connect(server)));
    return this.list();
  }

  list(): McpServerConfigState {
    return { servers: this.servers.map((server) => this.summary(server)) };
  }

  async add(input: McpServerInput): Promise<McpServerConfigState> {
    const server = normalizeServer({
      id: crypto.randomUUID(),
      ...input,
      enabled: input.enabled ?? true
    });
    this.servers.push(server);
    this.persist();
    await this.connect(server);
    return this.list();
  }

  async update(id: string, input: McpServerUpdate): Promise<McpServerConfigState | undefined> {
    const index = this.servers.findIndex((server) => server.id === id);
    if (index === -1) {
      return undefined;
    }
    const current = this.servers[index] as McpServerConfig;
    const next = normalizeServer({ ...current, ...input, id });
    await this.disconnect(id);
    this.servers[index] = next;
    this.persist();
    await this.connect(next);
    return this.list();
  }

  async remove(id: string): Promise<McpServerConfigState | undefined> {
    const index = this.servers.findIndex((server) => server.id === id);
    if (index === -1) {
      return undefined;
    }
    await this.disconnect(id);
    this.servers.splice(index, 1);
    this.persist();
    return this.list();
  }

  async reconnect(id: string): Promise<McpServerConfigState | undefined> {
    const server = this.servers.find((candidate) => candidate.id === id);
    if (!server) {
      return undefined;
    }
    await this.disconnect(id);
    await this.connect(server);
    return this.list();
  }

  async reload(): Promise<McpServerConfigState> {
    const nextServers = this.readConfig();
    await this.disconnectAll();
    this.servers = nextServers;
    return this.load();
  }

  async disconnectAll(): Promise<void> {
    const ids = [...this.connections.keys()];
    await Promise.allSettled(ids.map((id) => this.disconnect(id)));
    this.connections.clear();
  }

  private async connect(server: McpServerConfig): Promise<void> {
    const source = sourceId(server.id);
    this.options.registry.unregisterExternalTools(source);
    if (!server.enabled) {
      this.connections.set(server.id, { status: "disabled", toolCount: 0 });
      return;
    }
    let client: McpClientHandle | undefined;
    try {
      const resolved = this.resolve(server);
      client = this.options.createClient
        ? await this.options.createClient(resolved)
        : await connectMcpClient(resolved);
      const connectedClient = client;
      const tools = await connectedClient.listTools();
      const apiPrefix = `mcp_${safeIdentifier(server.id)}`;
      this.options.registry.registerTools(tools.map((tool) => externalMcpTool(
        {
          sourceId: `mcp.${server.id}`,
          apiName: `${apiPrefix}_${safeIdentifier(tool.name)}`,
          tags: ["mcp", server.name],
          useRemoteManifestId: false
        },
        tool,
        (args) => connectedClient.callTool(tool.name, args)
      )), source);
      this.connections.set(server.id, { status: "connected", toolCount: tools.length, client: connectedClient });
    } catch (error) {
      await client?.close().catch(() => undefined);
      this.connections.set(server.id, {
        status: "error",
        toolCount: 0,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async disconnect(id: string): Promise<void> {
    this.options.registry.unregisterExternalTools(sourceId(id));
    const state = this.connections.get(id);
    this.connections.delete(id);
    await state?.client?.close().catch(() => undefined);
  }

  private resolve(server: McpServerConfig): ResolvedMcpConnection {
    if (server.transport === "streamable-http") {
      return {
        transport: "streamable-http",
        name: server.name,
        url: server.url as string,
        headers: { ...(server.headers ?? {}) }
      };
    }
    return {
      transport: "stdio",
      name: server.name,
      command: normalizePortablePath(server.command as string),
      args: [...(server.args ?? [])],
      cwd: resolveWorkingDirectory(server.cwd, this.options.workspaceRoot),
      env: mergeEnvironment(this.options.env ?? process.env, server.env)
    };
  }

  private summary(server: McpServerConfig): McpServerSummary {
    const state = this.connections.get(server.id) ?? (
      server.enabled
        ? { status: "error" as const, toolCount: 0, error: "MCP server has not been connected" }
        : { status: "disabled" as const, toolCount: 0 }
    );
    return {
      id: server.id,
      name: server.name,
      transport: server.transport,
      enabled: server.enabled,
      status: state.status,
      toolCount: state.toolCount,
      envKeys: Object.keys(server.env ?? {}).sort(),
      headerNames: Object.keys(server.headers ?? {}).sort(),
      ...(server.command ? { command: server.command } : {}),
      ...(server.args ? { args: server.args } : {}),
      ...(server.cwd ? { cwd: server.cwd } : {}),
      ...(server.url ? { url: server.url } : {}),
      ...(state.error ? { error: state.error } : {})
    };
  }

  private readConfig(): McpServerConfig[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.options.filePath, "utf8")) as unknown;
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }
      throw new Error(`Failed to parse MCP config: ${this.options.filePath}`, { cause: error });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid MCP config: ${this.options.filePath}`);
    }
    const servers = (parsed as Partial<PersistedMcpConfig>).servers;
    if (!Array.isArray(servers)) {
      throw new Error(`MCP config must contain a servers array: ${this.options.filePath}`);
    }
    const normalized = servers.map((server) => normalizeServer(server));
    const ids = new Set<string>();
    for (const server of normalized) {
      if (ids.has(server.id)) {
        throw new Error(`Duplicate MCP server id: ${server.id}`);
      }
      ids.add(server.id);
    }
    return normalized;
  }

  private persist(): void {
    mkdirSync(path.dirname(this.options.filePath), { recursive: true });
    writeFileSync(this.options.filePath, `${JSON.stringify({ servers: this.servers }, null, 2)}\n`, "utf8");
  }
}

function normalizeServer(input: unknown): McpServerConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("MCP server config must be an object");
  }
  const raw = input as Record<string, unknown>;
  const id = requiredString(raw.id, "id");
  const name = requiredString(raw.name, "name");
  const transport = raw.transport;
  if (transport !== "stdio" && transport !== "streamable-http") {
    throw new Error(`MCP server ${id} transport must be stdio or streamable-http`);
  }
  const base: Pick<McpServerConfig, "id" | "name" | "transport" | "enabled"> = {
    id,
    name,
    transport,
    enabled: raw.enabled !== false
  };
  if (transport === "stdio") {
    const cwd = optionalString(raw.cwd);
    return {
      ...base,
      command: requiredString(raw.command, "command"),
      args: stringArray(raw.args, "args"),
      ...(cwd ? { cwd } : {}),
      ...(raw.env !== undefined ? { env: stringRecord(raw.env, "env") } : {})
    };
  }
  const url = requiredString(raw.url, "url");
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error(`MCP server ${id} URL must use http or https`);
  }
  return {
    ...base,
    url: parsedUrl.toString(),
    ...(raw.headers !== undefined ? { headers: stringRecord(raw.headers, "headers") } : {})
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`MCP server is missing required field: ${field}`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`MCP server ${field} must be an array of strings`);
  }
  return value.map(String);
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`MCP server ${field} must be an object of string values`);
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!key.trim() || typeof entry !== "string") {
      throw new Error(`MCP server ${field} must be an object of string values`);
    }
    result[key.trim()] = entry;
  }
  return result;
}

function resolveWorkingDirectory(value: string | undefined, workspaceRoot: string): string {
  const portable = normalizePortablePath(value ?? workspaceRoot);
  return path.resolve(path.isAbsolute(portable) ? portable : path.join(workspaceRoot, portable));
}

function mergeEnvironment(base: NodeJS.ProcessEnv, configured: Record<string, string> | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return { ...result, ...(configured ?? {}) };
}

function sourceId(id: string): string {
  return `mcp:${id}`;
}

function safeIdentifier(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^([^a-zA-Z_])/, "_$1");
  return normalized || "tool";
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
