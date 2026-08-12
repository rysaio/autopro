import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { PluginSummary, SkillSummary } from "@secops-agent/shared";
import {
  connectMcpClient,
  externalMcpTool,
  type McpClientHandle,
  type ResolvedStdioMcpServer
} from "../mcp/externalMcp.js";
import type { SecOpsTool } from "../tools/types.js";
import { ToolRegistry } from "../tools/registry.js";
import type { PluginSkillSource } from "../skills/catalog.js";

// ── 类型定义 ──

export type ResolvedMcpServer = ResolvedStdioMcpServer;
export type { McpClientHandle };

export interface PluginManagerOptions {
  pluginsDir: string;
  registry: ToolRegistry;
  env?: NodeJS.ProcessEnv;
  createClient?: (server: ResolvedMcpServer, pluginId: string) => Promise<McpClientHandle>;
}

interface PluginManifestFile {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  skills?: unknown;
  mcpServers?: unknown;
}

interface McpServerConfigFile {
  command?: unknown;
  args?: unknown;
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

  /** 断开全部已加载插件连接、移除其工具，再重新扫描加载（无需重启服务）。 */
  async reload(): Promise<void> {
    await this.disconnectAll();
    await this.load();
  }

  /** 断开全部插件 MCP 连接并从 registry 移除其工具。 */
  async disconnectAll(): Promise<void> {
    this.options.registry.unregisterExternalTools("plugins");
    const clients = [...this.plugins.values()].flatMap((plugin) => plugin.clients);
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
    for (const serverName of serverNames) {
      const config = mcpServers[serverName] as McpServerConfigFile;
      const resolved: ResolvedMcpServer = {
        transport: "stdio",
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
          : await connectMcpClient(resolved);
        const connectedClient = client;
        const tools = await connectedClient.listTools();
        const adaptedTools: SecOpsTool[] = tools.map((tool) => externalMcpTool(
          { sourceId: `${pluginId}.${serverName}`, tags: ["plugin", pluginId] },
          tool,
          (args) => connectedClient.callTool(tool.name, args)
        ));
        this.options.registry.registerTools(adaptedTools, "plugins");
        clients.push(connectedClient);
        toolCount += adaptedTools.length;
        serverStates.push({ name: serverName, status: "loaded", toolCount: adaptedTools.length });
      } catch (error) {
        await client?.close().catch(() => undefined);
        serverStates.push({
          name: serverName,
          status: "error",
          toolCount: 0,
          error: error instanceof Error ? error.message : String(error)
        });
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
      mcpServers: serverStates
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
    return {
      name: manifest.name,
      ...(typeof manifest.version === "string" ? { version: manifest.version } : {}),
      ...(typeof manifest.description === "string" ? { description: manifest.description } : {}),
      ...(manifest.skills !== undefined ? { skills: manifest.skills } : {}),
      ...(manifest.mcpServers !== undefined ? { mcpServers: manifest.mcpServers } : {})
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
