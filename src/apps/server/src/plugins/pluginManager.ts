import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type {
  PluginSummary,
  ToolClass,
  ToolRisk,
  ToolRoutingHints,
  ToolSchema
} from "@secops-agent/shared";
import type { ModelTool } from "../providers/types.js";
import type { PluginCachePolicy, PluginCachePolicyStore } from "../runtime/pluginCachePolicyStore.js";
import type { SecOpsTool, ToolContext, ToolExecutionResult } from "../tools/types.js";
import { ToolRegistry } from "../tools/registry.js";

// ── 类型定义 ──

export interface ResolvedMcpServer {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** 可注入的 MCP 客户端句柄（测试用假实现，生产用 SDK Client）。 */
export interface McpClientHandle {
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

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
  mcpServers?: unknown;
  keywords?: unknown;
  routing?: unknown;
}

interface McpServerConfigFile {
  command?: unknown;
  args?: unknown;
}

interface PluginState {
  id: string;
  name: string;
  version: string;
  status: "loaded" | "error";
  toolCount: number;
  error?: string;
  client?: McpClientHandle;
  /** Host-assigned load generation; bumped on every successful load/reload. */
  generation?: number;
}

// Codex 插件规范：manifest 为 .codex-plugin/plugin.json，mcpServers 字段指向
// .mcp.json 文件路径（或回退读取插件根目录 .mcp.json）
const MANIFEST_CANDIDATES = [".codex-plugin/plugin.json"];

// 插件自带 MCP server 的 action 开关：注入 true 让插件放行，动作审批统一由
// 主服务 ToolRegistry.decidePolicy 把守（stdio 私有点对点，外部无法绕过）。
const ACTION_ALLOW_ENV: Record<string, string> = {
  WAZUH_MCP_ALLOW_ACTIONS: "true",
  SHUFFLE_MCP_ALLOW_ACTIONS: "true"
};

/**
 * 插件管理器：扫描 runtime/plugins/<name>/，按 Claude Code / Codex 插件形态
 * （manifest + .mcp.json）spawn 插件自带 MCP server，把 listTools 结果注册为
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
    this.options.registry.unregisterExternalTools();
    const clients = [...this.plugins.values()].map((plugin) => plugin.client).filter(Boolean);
    for (const plugin of this.plugins.values()) {
      if (plugin.id) {
        this.options.registry.invalidateCacheNamespace(pluginCacheNamespace(plugin.id));
      }
    }
    this.plugins.clear();
    await Promise.allSettled(clients.map((client) => client?.close()));
  }

  status(): PluginSummary[] {
    return [...this.plugins.values()].map((plugin) => ({
      id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      status: plugin.status,
      toolCount: plugin.toolCount,
      ...(plugin.error ? { error: plugin.error } : {})
    }));
  }

  private async loadPlugin(pluginId: string): Promise<void> {
    const dir = path.join(this.options.pluginsDir, pluginId);
    const manifest = readPluginManifest(dir);
    if (!manifest) {
      this.setError(pluginId, "Missing plugin manifest (.codex-plugin/plugin.json)");
      return;
    }
    const pluginKeywords = toValidatedTags(manifest.keywords);
    const pluginRouting = toRoutingHints(manifest.routing);
    const mcpServers = readMcpServerConfigs(dir, manifest);
    const serverNames = Object.keys(mcpServers);
    if (serverNames.length === 0) {
      this.setError(pluginId, "Plugin declares no MCP servers");
      return;
    }
    // 取插件声明的第一个 MCP server（插件通常只声明一个）
    const serverName = serverNames[0] as string;
    const config = mcpServers[serverName] as McpServerConfigFile;
    const resolved: ResolvedMcpServer = {
      name: serverName,
      command: config.command as string,
      args: Array.isArray(config.args) ? config.args.map(String) : [],
      cwd: dir,
      env: buildSpawnEnv(this.options.env ?? process.env)
    };
    let client: McpClientHandle | undefined;
    try {
      client = this.options.createClient
        ? await this.options.createClient(resolved, pluginId)
        : await connectStdioClient(resolved);
      const tools = await client.listTools();
      const generation = this.nextGeneration++;
      const secOpsTools = tools.map((tool) => {
        const meta = tool._meta ?? {};
        const manifestId = typeof meta.manifestId === "string" && meta.manifestId.length > 0
          ? meta.manifestId
          : `${pluginId}.${tool.name}`;
        const cachePolicy = this.options.cachePolicyStore?.policyFor(manifestId);
        return mcpToolToSecOpsTool(
          pluginId,
          generation,
          tool,
          (args) => client!.callTool(tool.name, args),
          cachePolicy,
          pluginKeywords,
          pluginRouting
        );
      });
      this.options.registry.registerTools(secOpsTools);
      this.plugins.set(pluginId, {
        id: pluginId,
        name: manifest.name,
        version: manifest.version ?? "",
        status: "loaded",
        toolCount: tools.length,
        client,
        generation
      });
    } catch (error) {
      // 注册失败或 listTools 失败：释放已建立的连接，避免 MCP 子进程泄漏
      if (client) {
        await client.close().catch(() => undefined);
      }
      this.setError(pluginId, error instanceof Error ? error.message : String(error));
    }
  }

  private setError(pluginId: string, message: string): void {
    const existing = this.plugins.get(pluginId);
    const state: PluginState = {
      id: pluginId,
      name: existing?.name ?? pluginId,
      version: existing?.version ?? "",
      status: "error",
      toolCount: 0,
      error: message
    };
    this.plugins.set(pluginId, state);
  }
}

// ── manifest 与 MCP 配置读取 ──

function readPluginManifest(
  dir: string
): { name: string; version?: string; mcpServers?: unknown; keywords?: string[]; routing?: ToolRoutingHints } | undefined {
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
      if (typeof cfg.command === "string" && cfg.command.length > 0) {
        result[name] = { command: cfg.command, ...(Array.isArray(cfg.args) ? { args: cfg.args } : {}) };
      }
    }
    if (Object.keys(result).length > 0) {
      return result;
    }
  }
  return {};
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

async function connectStdioClient(server: ResolvedMcpServer): Promise<McpClientHandle> {
  const client = new Client({ name: "secops-agent-host", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    cwd: server.cwd,
    env: server.env,
    stderr: "pipe"
  });
  await client.connect(transport);
  return {
    listTools: async () => {
      const result = await client.listTools();
      return result.tools;
    },
    callTool: async (name, args): Promise<CallToolResult> => {
      const result = await client.callTool({ name, arguments: args });
      // SDK 返回内联结构（与 CallToolResult 形状一致），此处显式断言
      return result as CallToolResult;
    },
    close: async () => {
      await client.close();
    }
  };
}

// ── MCP 工具 → SecOpsTool 适配 ──

function mcpToolToSecOpsTool(
  pluginId: string,
  generation: number,
  tool: Tool,
  call: (args: Record<string, unknown>) => Promise<CallToolResult>,
  cachePolicy?: PluginCachePolicy,
  pluginTags: string[] = [],
  pluginRouting?: ToolRoutingHints
): SecOpsTool {
  const meta = tool._meta ?? {};
  const manifestId = typeof meta.manifestId === "string" && meta.manifestId.length > 0
    ? meta.manifestId
    : `${pluginId}.${tool.name}`;
  const schema = toToolSchema(tool.inputSchema);
  const toolClass = toToolClass(meta.toolClass);
  const routing = toRoutingHints(meta.routing) ?? pluginRouting;
  const tags = uniqueStrings([
    pluginId,
    ...pluginTags,
    ...toValidatedTags(meta.tags),
    ...derivedAnnotationTags(tool)
  ]);
  // 仅当 host 策略显式启用且工具不是 action、未被 MCP 注解标记为显式非只读时注入缓存策略。
  // MCP readOnly/idempotent 注解只用于拒绝 unsafe 策略，绝不自动启用缓存。
  const resultCache = cachePolicy && isCacheEligible(tool, toolClass)
    ? {
        version: `plugin:${pluginId}:gen${generation}`,
        dataSource: pluginId,
        ttlMs: cachePolicy.ttlMs,
        namespace: pluginCacheNamespace(pluginId)
      }
    : undefined;
  return {
    apiName: tool.name,
    manifest: {
      id: manifestId,
      skillPackId: pluginId,
      name: typeof tool.title === "string" && tool.title.length > 0 ? tool.title : tool.name,
      description: tool.description ?? "",
      toolClass,
      risk: toToolRisk(meta.risk),
      // 缺失/无效的 deferLoading 默认按需（true）：未知插件工具不得因此变成常驻。
      deferLoading: meta.deferLoading !== false,
      inputSchema: schema,
      tags,
      mcpCompatible: true,
      ...(routing ? { routing } : {}),
      ...(resultCache ? { resultCache } : {})
    },
    toModelTool(): ModelTool {
      return {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description ?? "",
          parameters: schema as unknown as Record<string, unknown>
        }
      };
    },
    async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolExecutionResult> {
      const result = await call(args);
      return parseCallResult(result);
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

function toToolClass(value: unknown): ToolClass {
  return value === "perception" || value === "reasoning" || value === "evidence" || value === "action"
    ? value
    : "perception";
}

function toToolRisk(value: unknown): ToolRisk {
  // risk 缺失时默认 high（保守）：插件未声明风险即按高危 action 处理，仍需审批
  return value === "low" || value === "medium" || value === "high" ? value : "high";
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

/** Host isolation scope for a plugin's cached results. */
function pluginCacheNamespace(pluginId: string): string {
  return `plugin:${pluginId}`;
}

/**
 * A plugin tool may be cached only when it is not an action and is not
 * explicitly annotated non-read-only. readOnly/idempotent hints never enable
 * caching by themselves; the host policy must opt in first.
 */
function isCacheEligible(tool: Tool, toolClass: ToolClass): boolean {
  if (toolClass === "action") {
    return false;
  }
  const meta = tool._meta ?? {};
  const annotations = (tool as { annotations?: Record<string, unknown> }).annotations ?? {};
  const readOnly = meta.readOnlyHint ?? annotations.readOnlyHint ?? (tool as { readOnlyHint?: unknown }).readOnlyHint;
  const idempotent = meta.idempotentHint ?? annotations.idempotentHint ?? (tool as { idempotentHint?: unknown }).idempotentHint;
  return readOnly !== false && idempotent !== false;
}
