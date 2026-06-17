import dotenv from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AutomationLevel } from "@secops-agent/shared";

const discoveredWorkspaceRoot = findWorkspaceRoot(process.cwd());
dotenv.config({ path: path.join(discoveredWorkspaceRoot, ".env") });
dotenv.config();

const DEFAULT_ALLOWED_HOSTS = ["localhost", "127.0.0.1", "::1"];
const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:5317", "http://127.0.0.1:5317"];

export interface AppConfig {
  port: number;
  bindHost: string;
  provider: string;
  model: string;
  modelApiKey: string | undefined;
  modelBaseUrl: string | undefined;
  actionLevel: AutomationLevel;
  sandboxRoot: string;
  workspaceRoot: string;
  runtimeConfigPath: string;
  auditLogPath: string;
  approvalStorePath: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  apiToken: string | undefined;
}

interface FileConfig {
  model?: {
    provider?: string;
    name?: string;
    baseUrl?: string;
    apiKeyEnv?: string;
  };
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const workspaceRoot = path.resolve(env.SECOPS_WORKSPACE_ROOT?.trim() || discoveredWorkspaceRoot);
  const fileConfig = loadFileConfig(env.SECOPS_CONFIG_PATH, workspaceRoot);
  const provider = env.MODEL_PROVIDER?.trim() || fileConfig.model?.provider?.trim() || "openai-compatible";
  const model = env.SECOPS_MODEL?.trim() || env.MODEL_NAME?.trim() || fileConfig.model?.name?.trim() || "";
  const modelBaseUrl = env.MODEL_BASE_URL?.trim() || fileConfig.model?.baseUrl?.trim();
  const apiKeyFromConfiguredEnv = fileConfig.model?.apiKeyEnv ? env[fileConfig.model.apiKeyEnv]?.trim() : undefined;
  const modelApiKey = env.MODEL_API_KEY?.trim() || apiKeyFromConfiguredEnv;
  const actionLevel = parseActionLevel(env.SECOPS_ACTION_LEVEL);

  return {
    port: Number(env.PORT ?? 4317),
    bindHost: env.SECOPS_BIND_HOST?.trim() || "127.0.0.1",
    provider,
    model,
    modelApiKey,
    modelBaseUrl,
    actionLevel,
    sandboxRoot: resolveWorkspacePath(env.SECOPS_SANDBOX_ROOT, workspaceRoot, path.join("runtime", "sandbox")),
    workspaceRoot,
    runtimeConfigPath: resolveWorkspacePath(env.SECOPS_RUNTIME_CONFIG_PATH, workspaceRoot, path.join("runtime", "config", "settings.json")),
    auditLogPath: resolveWorkspacePath(env.SECOPS_AUDIT_LOG_PATH, workspaceRoot, path.join("runtime", "audit", "events.jsonl")),
    approvalStorePath: resolveWorkspacePath(env.SECOPS_APPROVAL_STORE_PATH, workspaceRoot, path.join("runtime", "approvals", "pending.json")),
    allowedHosts: parseCsv(env.SECOPS_ALLOWED_HOSTS) ?? DEFAULT_ALLOWED_HOSTS,
    allowedOrigins: parseCsv(env.SECOPS_ALLOWED_ORIGINS) ?? DEFAULT_ALLOWED_ORIGINS,
    apiToken: env.SECOPS_API_TOKEN?.trim() || undefined
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

export function missingModelConfig(config: Pick<AppConfig, "model" | "modelApiKey" | "modelBaseUrl">): string[] {
  return [
    config.model ? undefined : "SECOPS_MODEL or MODEL_NAME",
    config.modelApiKey ? undefined : "MODEL_API_KEY",
    config.modelBaseUrl ? undefined : "MODEL_BASE_URL"
  ].filter((item): item is string => Boolean(item));
}

export function isModelConfigured(config: Pick<AppConfig, "model" | "modelApiKey" | "modelBaseUrl">): boolean {
  return missingModelConfig(config).length === 0;
}

function loadFileConfig(configPath: string | undefined, workspaceRoot: string): FileConfig {
  const resolvedPath = resolveWorkspacePath(configPath, workspaceRoot, "secops.config.json");
  if (!existsSync(resolvedPath)) {
    return {};
  }
  const parsed = JSON.parse(readFileSync(resolvedPath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid config file: ${resolvedPath}`);
  }
  return parsed as FileConfig;
}

function resolveWorkspacePath(value: string | undefined, workspaceRoot: string, fallback: string): string {
  const raw = value?.trim() || fallback;
  return path.resolve(path.isAbsolute(raw) ? raw : path.join(workspaceRoot, raw));
}

function parseActionLevel(value: string | undefined): AutomationLevel {
  if (value === "observe" || value === "sandbox" || value === "full-access") {
    return value;
  }
  return "sandbox";
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
