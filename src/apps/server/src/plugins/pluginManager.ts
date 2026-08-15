import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { PluginSummary, SkillSummary, ToolRoutingHints } from "@secops-agent/shared";
import {
  connectMcpClient,
  externalMcpTool,
  type McpClientHandle,
  type ResolvedMcpConnection
} from "../mcp/externalMcp.js";
import type { SecOpsTool } from "../tools/types.js";
import type { PluginCachePolicyStore } from "../runtime/pluginCachePolicyStore.js";
import { ToolRegistry } from "../tools/registry.js";
import { normalizePortablePath } from "../runtime/portablePath.js";
import type { PluginSkillSource } from "../skills/catalog.js";

// ── 类型定义 ──

export type ResolvedMcpServer = ResolvedMcpConnection;
export type { McpClientHandle };

export interface PluginManagerOptions {
  pluginsDir: string;
  registry: ToolRegistry;
  env?: NodeJS.ProcessEnv;
  createClient?: (server: ResolvedMcpServer, pluginId: string) => Promise<McpClientHandle>;
  /** Host-owned persisted cache policy; missing store = plugin caching disabled. */
  cachePolicyStore?: PluginCachePolicyStore;
}

interface PluginManifestFile {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  skills?: unknown;
  mcpServers?: unknown;
  keywords?: unknown;
  routing?: unknown;
}

interface McpServerConfigFile {
  type?: unknown;
  command?: unknown;
  args?: unknown;
  url?: unknown;
  headers?: unknown;
  httpHeaders?: unknown;
  envHttpHeaders?: unknown;
  env_http_headers?: unknown;
  bearerTokenEnvVar?: unknown;
  bearer_token_env_var?: unknown;
}

interface PluginState {
  id: string;
  name: string;
  version: string;
  description: string;
  status: "loaded" | "degraded" | "error";
  toolCount: number;
  error?: string;
  loadErrors: string[];
  pluginRoot: string;
  skillsRoot?: string;
  skills: SkillSummary[];
  clients: McpClientHandle[];
  mcpServers: NonNullable<PluginSummary["mcpServers"]>;
  /** Host-assigned load generation; bumped on every successful load/reload. */
  generation?: number;
}

// Codex 插件规范：manifest 为 .codex-plugin/plugin.json，mcpServers 字段指向
// .mcp.json 文件路径（或回退读取插件根目录 .mcp.json）
const MANIFEST_CANDIDATES = [".codex-plugin/plugin.json"];

// 插件自带 MCP server 的 action 开关：注入 true 让插件放行，动作审批统一由
// 主服务 ToolRegistry.decidePolicy 把守（stdio 与 HTTP 服务同样受主服务约束）。
const ACTION_ALLOW_ENV: Record<string, string> = {
  WAZUH_MCP_ALLOW_ACTIONS: "true",
  SHUFFLE_MCP_ALLOW_ACTIONS: "true"
};

/**
 * 插件管理器：扫描 runtime/plugins/<name>/，按 Claude Code / Codex 插件形态
 * （manifest + .mcp.json）连接插件自带 MCP server（stdio 或 streamable-http），把 listTools 结果注册为
 * 主服务的 SecOpsTool。load()/reload() 实现“安装后重新加载一次即可 reach”。
 */
export class PluginManager {
  private readonly plugins = new Map<string, PluginState>();
  private nextGeneration = 1;
  /** reload 互斥：并发 reload/策略变更合并为一次串行执行，避免 registerTools 交错冲突。 */
  private reloadInFlight: Promise<void> | undefined;

  constructor(private readonly options: PluginManagerOptions) {}

  /** 扫描插件目录并加载所有插件；单插件失败只记录 error，不影响服务与其他插件。 */
  async load(): Promise<void> {
    const dir = this.options.pluginsDir;
    const entries = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [];
    const pluginDirs = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
    for (const pluginId of pluginDirs) {
      await this.loadPlugin(pluginId);
    }
  }

  /** 断开全部已加载插件连接、移除其工具，再重新扫描加载（无需重启服务）。
   *  并发调用共享同一次执行（合并），保证串行且不交错。 */
  reload(): Promise<void> {
    if (this.reloadInFlight) {
      return this.reloadInFlight;
    }
    const operation = (async () => {
      await this.disconnectAll();
      await this.load();
    })();
    this.reloadInFlight = operation;
    operation.finally(() => {
      if (this.reloadInFlight === operation) {
        this.reloadInFlight = undefined;
      }
    }).catch(() => undefined);
    return operation;
  }

  /** 断开全部插件 MCP 连接并从 registry 移除其工具，同时立即回收其缓存条目。 */
  async disconnectAll(): Promise<void> {
    this.options.registry.unregisterExternalTools("plugins");
    const clients = [...this.plugins.values()].flatMap((plugin) => plugin.clients);
    for (const plugin of this.plugins.values()) {
      this.options.registry.invalidateCacheNamespace(pluginCacheNamespace(plugin.id));
    }
    this.plugins.clear();
    await Promise.allSettled(clients.map((client) => client.close()));
  }

  status(): PluginSummary[] {
    return [...this.plugins.values()].map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      status: plugin.status,
      toolCount: plugin.toolCount,
      skillCount: plugin.skills.length,
      mcpServers: plugin.mcpServers,
      ...(plugin.error ? { error: plugin.error } : {})
    }));
  }

  skillSources(): PluginSkillSource[] {
    return [...this.plugins.values()].flatMap((plugin) => plugin.skillsRoot ? [{
      pluginId: plugin.id,
      pluginRoot: plugin.pluginRoot,
      skillsRoot: plugin.skillsRoot
    }] : []);
  }

  applySkillResults(skills: SkillSummary[]): void {
    for (const plugin of this.plugins.values()) {
      plugin.skills = skills.filter((skill) => skill.pluginId === plugin.id);
      refreshPluginStatus(plugin);
    }
  }

  private async loadPlugin(pluginId: string): Promise<void> {
    const dir = path.join(this.options.pluginsDir, pluginId);
    const manifest = readPluginManifest(dir);
    if (!manifest) {
      this.setError(pluginId, "Missing plugin manifest (.codex-plugin/plugin.json)");
      return;
    }
    const loadErrors: string[] = [];
    const skillsRoot = typeof manifest.skills === "string" && manifest.skills.trim()
      ? path.resolve(dir, manifest.skills)
      : undefined;
    if (manifest.skills !== undefined && !skillsRoot) {
      loadErrors.push("Plugin skills declaration must be a non-empty path string");
    }
    const pluginKeywords = toValidatedTags(manifest.keywords);
    const pluginRouting = toRoutingHints(manifest.routing);
    const mcpServers = readMcpServerConfigs(dir, manifest);
    const serverNames = Object.keys(mcpServers);
    if (serverNames.length === 0 && (
      manifest.mcpServers !== undefined || existsSync(path.join(dir, ".mcp.json"))
    )) {
      loadErrors.push("Plugin MCP configuration contains no valid servers");
    }
    const clients: McpClientHandle[] = [];
    const serverStates: NonNullable<PluginSummary["mcpServers"]> = [];
    let toolCount = 0;
    let generation: number | undefined;
    for (const serverName of serverNames) {
      const config = mcpServers[serverName] as McpServerConfigFile;
      let client: McpClientHandle | undefined;
      let resolved: ResolvedMcpServer | undefined;
      try {
        resolved = resolveMcpServer(serverName, config, dir, this.options.env ?? process.env);
        client = this.options.createClient
          ? await this.options.createClient(resolved, pluginId)
          : await connectMcpClient(resolved);
        const connectedClient = client;
        const tools = await connectedClient.listTools();
        generation ??= this.nextGeneration++;
        const adaptedTools: SecOpsTool[] = tools.map((tool) => {
          const meta = tool._meta ?? {};
          const manifestId = typeof meta.manifestId === "string" && meta.manifestId.length > 0
            ? meta.manifestId
            : `${pluginId}.${tool.name}`;
          const cachePolicy = this.options.cachePolicyStore?.policyFor(manifestId);
          return externalMcpTool(
            {
              sourceId: `${pluginId}.${serverName}`,
              tags: ["plugin", pluginId, ...pluginKeywords],
              routing: pluginRouting,
              deferByDefault: true,
              ...(cachePolicy
                ? {
                    resultCache: {
                      enabled: cachePolicy.enabled,
                      version: `plugin:${pluginId}:gen${generation}`,
                      dataSource: pluginId,
                      ttlMs: cachePolicy.ttlMs,
                      namespace: pluginCacheNamespace(pluginId)
                    }
                  }
                : {})
            },
            tool,
            (args) => connectedClient.callTool(tool.name, args)
          );
        });
        this.options.registry.registerTools(adaptedTools, "plugins");
        clients.push(connectedClient);
        toolCount += adaptedTools.length;
        serverStates.push(pluginMcpServerSummary(serverName, resolved, "loaded", adaptedTools.length));
      } catch (error) {
        await client?.close().catch(() => undefined);
        serverStates.push(pluginMcpServerSummary(
          serverName,
          resolved,
          "error",
          0,
          error instanceof Error ? error.message : String(error)
        ));
      }
    }
    const state: PluginState = {
      id: pluginId,
      name: manifest.name,
      version: manifest.version ?? "",
      description: manifest.description ?? "",
      status: "error",
      toolCount,
      loadErrors,
      pluginRoot: dir,
      ...(skillsRoot ? { skillsRoot } : {}),
      skills: [],
      clients,
      mcpServers: serverStates,
      ...(generation !== undefined ? { generation } : {})
    };
    if (!skillsRoot && serverNames.length === 0 && loadErrors.length === 0) {
      state.loadErrors.push("Plugin declares no skills or MCP servers");
    }
    refreshPluginStatus(state);
    this.plugins.set(pluginId, state);
  }

  private setError(pluginId: string, message: string): void {
    const existing = this.plugins.get(pluginId);
    const state: PluginState = {
      id: pluginId,
      name: existing?.name ?? pluginId,
      version: existing?.version ?? "",
      description: existing?.description ?? "",
      status: "error",
      toolCount: 0,
      loadErrors: [message],
      pluginRoot: path.join(this.options.pluginsDir, pluginId),
      skills: [],
      clients: [],
      mcpServers: [],
      error: message
    };
    this.plugins.set(pluginId, state);
  }
}

function refreshPluginStatus(plugin: PluginState): void {
  const errors = [
    ...plugin.loadErrors,
    ...plugin.mcpServers
      .filter((server) => server.status === "error")
      .map((server) => `${server.name}: ${server.error ?? "connection failed"}`),
    ...plugin.skills
      .filter((skill) => skill.status === "error")
      .map((skill) => `${skill.name}: ${skill.error ?? "load failed"}`)
  ];
  const hasUsableContent = plugin.clients.length > 0 || plugin.skills.some((skill) => skill.status === "loaded");
  plugin.status = hasUsableContent ? (errors.length ? "degraded" : "loaded") : "error";
  if (!hasUsableContent && errors.length === 0) {
    errors.push("Plugin has no usable skills or MCP servers");
  }
  if (errors.length) {
    plugin.error = errors.join("; ");
  } else {
    delete plugin.error;
  }
}

// ── manifest 与 MCP 配置读取 ──

function readPluginManifest(dir: string): {
  name: string;
  version?: string;
  description?: string;
  skills?: unknown;
  mcpServers?: unknown;
  keywords?: string[];
  routing?: ToolRoutingHints;
} | undefined {
  for (const relative of MANIFEST_CANDIDATES) {
    const manifestPath = path.join(dir, relative);
    if (!existsSync(manifestPath)) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const manifest = parsed as PluginManifestFile;
    if (typeof manifest.name !== "string" || manifest.name.length === 0) {
      continue;
    }
    const keywords = toValidatedTags(manifest.keywords);
    const routing = toRoutingHints(manifest.routing);
    return {
      name: manifest.name,
      ...(typeof manifest.version === "string" ? { version: manifest.version } : {}),
      ...(typeof manifest.description === "string" ? { description: manifest.description } : {}),
      ...(manifest.skills !== undefined ? { skills: manifest.skills } : {}),
      ...(manifest.mcpServers !== undefined ? { mcpServers: manifest.mcpServers } : {}),
      ...(keywords.length > 0 ? { keywords } : {}),
      ...(routing ? { routing } : {})
    };
  }
  return undefined;
}

function readMcpServerConfigs(
  dir: string,
  manifest: { mcpServers?: unknown }
): Record<string, McpServerConfigFile> {
  const candidates: string[] = [];
  if (typeof manifest.mcpServers === "string") {
    candidates.push(path.resolve(dir, manifest.mcpServers));
  }
  candidates.push(path.join(dir, ".mcp.json"));
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(candidate, "utf8")) as unknown;
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const servers = (parsed as { mcpServers?: unknown }).mcpServers ?? parsed;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
      continue;
    }
    const result: Record<string, McpServerConfigFile> = {};
    for (const [name, config] of Object.entries(servers as Record<string, unknown>)) {
      if (!config || typeof config !== "object" || Array.isArray(config)) {
        continue;
      }
      const cfg = config as McpServerConfigFile;
      const hasCommand = typeof cfg.command === "string" && cfg.command.length > 0;
      const hasUrl = typeof cfg.url === "string" && cfg.url.trim().length > 0 && isHttpTransport(cfg.type);
      if (hasCommand || hasUrl) {
        result[name] = { ...cfg };
      }
    }
    if (Object.keys(result).length > 0) {
      return result;
    }
  }
  return {};
}

function pluginMcpServerSummary(
  name: string,
  resolved: ResolvedMcpServer | undefined,
  status: "loaded" | "error",
  toolCount: number,
  error?: string
): NonNullable<PluginSummary["mcpServers"]>[number] {
  return {
    name,
    status,
    toolCount,
    ...(resolved ? { transport: resolved.transport } : {}),
    ...(resolved?.transport === "streamable-http"
      ? { url: resolved.url, headerNames: Object.keys(resolved.headers).sort() }
      : {}),
    ...(resolved?.transport === "stdio"
      ? { command: resolved.command, args: resolved.args }
      : {}),
    ...(error ? { error } : {})
  };
}

function resolveMcpServer(
  name: string,
  config: McpServerConfigFile,
  pluginRoot: string,
  env: NodeJS.ProcessEnv
): ResolvedMcpServer {
  if (typeof config.command === "string" && config.command.length > 0) {
    return {
      transport: "stdio",
      name,
      command: normalizePortablePath(config.command),
      args: Array.isArray(config.args) ? config.args.map(String) : [],
      cwd: pluginRoot,
      env: buildSpawnEnv(env)
    };
  }
  const rawUrl = typeof config.url === "string" ? config.url.trim() : "";
  if (!rawUrl) {
    throw new Error(`MCP server ${name} must declare command or url`);
  }
  return {
    transport: "streamable-http",
    name,
    url: normalizeHttpUrl(rawUrl),
    headers: buildHttpHeaders(config, env)
  };
}

function isHttpTransport(type: unknown): boolean {
  if (type === undefined) {
    return true;
  }
  return typeof type === "string" && (type.toLowerCase() === "http" || type.toLowerCase() === "streamable-http");
}

function normalizeHttpUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid MCP server URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`MCP server URL must use http or https: ${rawUrl}`);
  }
  return parsed.toString();
}

function buildHttpHeaders(config: McpServerConfigFile, env: NodeJS.ProcessEnv): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(stringRecord(config.headers ?? config.httpHeaders))) {
    const resolved = resolveHeaderValue(value, env);
    if (resolved !== undefined) {
      headers[key] = resolved;
    }
  }
  for (const [key, envVar] of Object.entries(stringRecord(config.envHttpHeaders ?? config.env_http_headers))) {
    const value = env[envVar];
    if (typeof value === "string" && value.length > 0) {
      headers[key] = value;
    }
  }
  const bearerTokenEnvVar = optionalString(config.bearerTokenEnvVar) ?? optionalString(config.bearer_token_env_var);
  if (bearerTokenEnvVar) {
    const token = env[bearerTokenEnvVar];
    if (typeof token === "string" && token.length > 0) {
      headers.Authorization = `Bearer ${token}`;
    }
  }
  return headers;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      result[key] = entry;
    }
  }
  return result;
}

function resolveHeaderValue(value: string, env: NodeJS.ProcessEnv): string | undefined {
  let unresolved = false;
  const resolved = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key: string) => {
    const replacement = env[key];
    if (replacement === undefined || replacement === "") {
      unresolved = true;
      return "";
    }
    return replacement;
  });
  return unresolved ? undefined : resolved;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildSpawnEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  // 插件侧对 action 全放行，审批统一由主服务 decidePolicy 把关
  env.SECOPS_ACTION_LEVEL = "full-access";
  Object.assign(env, ACTION_ALLOW_ENV);
  return env;
}

/**
 * Validates optional routing metadata. Missing or malformed values return
 * undefined so the router falls back to hints derived from identity, name,
 * description, and tags. Invalid entries are ignored rather than trusted.
 */
function toRoutingHints(value: unknown): ToolRoutingHints | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const group = typeof raw.group === "string" && raw.group.trim().length > 0
    ? raw.group.trim()
    : undefined;
  const keywords = toValidatedTags(raw.keywords);
  if (!group && keywords.length === 0) {
    return undefined;
  }
  return {
    ...(group ? { group } : {}),
    ...(keywords.length > 0 ? { keywords } : {})
  };
}

/** Accepts only non-empty strings; duplicate and malformed entries are dropped. */
function toValidatedTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return uniqueStrings(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim()));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
/** Host isolation scope for a plugin's cached results. */
function pluginCacheNamespace(pluginId: string): string {
  return `plugin:${pluginId}`;
}
