import dotenv from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AgentRoutingMode, AutomationLevel } from "@secops-agent/shared";

const discoveredWorkspaceRoot = findWorkspaceRoot(process.cwd());
dotenv.config({ path: path.join(discoveredWorkspaceRoot, ".env") });
dotenv.config();

const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "::1"];
const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:5317", "http://127.0.0.1:5317"];

export interface AppConfig {
  port: number;
  bindHost: string;
  actionLevel: AutomationLevel;
  agentRoutingMode: AgentRoutingMode;
  sandboxRoot: string;
  workspaceRoot: string;
  runtimeConfigPath: string;
  modelConfigPath: string;
  toolVisibilityPath: string;
  auditLogPath: string;
  approvalStorePath: string;
  dataDir: string;
  durableSessionMode: "postgres" | "disabled";
  allowedHosts: string[];
  allowedOrigins: string[];
  apiToken: string | undefined;
  pluginsDir: string;
  agentRunTimeoutMs: number;
  /** Issue #10：持久化队列参数（有界、可配置、保守默认值）。 */
  persistQueueCapacity: number;
  persistQueueBatchSize: number;
  persistQueueFlushIntervalMs: number;
  persistQueueDrainTimeoutMs: number;
  persistQueueSaturationWaitMs: number;
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const workspaceRoot = path.resolve(env.SECOPS_WORKSPACE_ROOT?.trim() || discoveredWorkspaceRoot);
  const actionLevel = parseActionLevel(env.SECOPS_ACTION_LEVEL);

  return {
    port: Number(env.PORT) || 4317,
    bindHost: env.SECOPS_BIND_HOST?.trim() || "127.0.0.1",
    actionLevel,
    agentRoutingMode: parseAgentRoutingMode(env.SECOPS_AGENT_ROUTING_MODE),
    sandboxRoot: resolveWorkspacePath(env.SECOPS_SANDBOX_ROOT, workspaceRoot, path.join("runtime", "sandbox")),
    workspaceRoot,
    runtimeConfigPath: resolveWorkspacePath(env.SECOPS_RUNTIME_CONFIG_PATH, workspaceRoot, path.join("runtime", "config", "settings.json")),
    modelConfigPath: resolveWorkspacePath(env.SECOPS_MODEL_CONFIG_PATH, workspaceRoot, path.join("runtime", "config", "model.json")),
    toolVisibilityPath: resolveWorkspacePath(env.SECOPS_TOOL_VISIBILITY_PATH, workspaceRoot, path.join("runtime", "config", "toolVisibility.json")),
    auditLogPath: resolveWorkspacePath(env.SECOPS_AUDIT_LOG_PATH, workspaceRoot, path.join("runtime", "audit", "events.jsonl")),
    approvalStorePath: resolveWorkspacePath(env.SECOPS_APPROVAL_STORE_PATH, workspaceRoot, path.join("runtime", "approvals", "pending.json")),
    dataDir: resolveDataDir(env.SECOPS_DATA_DIR, workspaceRoot),
    durableSessionMode: (env.SECOPS_DURABLE_SESSIONS ?? "").trim().toLowerCase() === "off" ? "disabled" : "postgres",
    allowedHosts: parseCsv(env.SECOPS_ALLOWED_HOSTS) ?? DEFAULT_ALLOWED_HOSTS,
    allowedOrigins: parseCsv(env.SECOPS_ALLOWED_ORIGINS) ?? DEFAULT_ALLOWED_ORIGINS,
    apiToken: env.SECOPS_API_TOKEN?.trim() || undefined,
    pluginsDir: resolveWorkspacePath(env.SECOPS_PLUGINS_DIR, workspaceRoot, path.join("runtime", "plugins")),
    agentRunTimeoutMs: parsePositiveInteger(env.SECOPS_AGENT_RUN_TIMEOUT_MS, 5 * 60 * 1000),
    persistQueueCapacity: parsePositiveInteger(env.SECOPS_PERSIST_QUEUE_CAPACITY, 512),
    persistQueueBatchSize: parsePositiveInteger(env.SECOPS_PERSIST_BATCH_SIZE, 32),
    persistQueueFlushIntervalMs: parseNonNegativeInteger(env.SECOPS_PERSIST_FLUSH_INTERVAL_MS, 20),
    persistQueueDrainTimeoutMs: parsePositiveInteger(env.SECOPS_PERSIST_DRAIN_TIMEOUT_MS, 5000),
    persistQueueSaturationWaitMs: parseNonNegativeInteger(env.SECOPS_PERSIST_SATURATION_WAIT_MS, 1000)
  };
}

function findWorkspaceRoot(start: string): string {
  let current = path.resolve(start);
  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { workspaces?: unknown };
        if (Array.isArray(parsed.workspaces)) {
          return current;
        }
      } catch {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(start);
    }
    current = parent;
  }
}

function resolveWorkspacePath(value: string | undefined, workspaceRoot: string, fallback: string): string {
  const raw = value?.trim() || fallback;
  return path.resolve(path.isAbsolute(raw) ? raw : path.join(workspaceRoot, raw));
}

// Embedded PGlite data directory. "memory://" keeps the database in-memory
// (ephemeral); any other value is a filesystem path that persists sessions
// across restarts. Defaults to runtime/pgdata under the workspace root.
function resolveDataDir(value: string | undefined, workspaceRoot: string): string {
  const raw = value?.trim() || path.join("runtime", "pgdata");
  if (raw === "memory://" || raw.startsWith("memory:")) {
    return "memory://";
  }
  return path.resolve(path.isAbsolute(raw) ? raw : path.join(workspaceRoot, raw));
}

function parseActionLevel(value: string | undefined): AutomationLevel {
  if (value === "observe" || value === "sandbox" || value === "full-access") {
    return value;
  }
  return "sandbox";
}

function parseAgentRoutingMode(value: string | undefined): AgentRoutingMode {
  return value?.trim().toLowerCase() === "layered" ? "layered" : "deterministic";
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
