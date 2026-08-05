import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ModelConfigState, ModelConnectionSummary } from "@secops-agent/shared";

/** 完整模型连接（含明文 apiKey）。仅存在于服务端内存与持久化文件中，永不通过 API 下发。 */
export interface ModelConnection {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
}

export interface NewModelConnectionInput {
  id?: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
}

export interface UpdateModelConnectionInput {
  name?: string;
  provider?: string;
  model?: string;
  baseUrl?: string;
  /** 省略=保留旧值；显式传空串=清除 apiKey。 */
  apiKey?: string;
}

interface PersistedModelConfig {
  connections: ModelConnection[];
  activeConnectionId: string | null;
}

const REQUIRED_FIELDS = ["name", "provider", "model", "baseUrl"] as const;

/**
 * 模型配置热存储：明文读写 runtime/config/model.json。
 * 启动前后入口一致——唯一事实来源就是该文件：
 * - 启动前：直接编辑文件，启动时读取
 * - 启动后：直接编辑文件，再调用 reload()（后端 POST /api/model-config/reload，
 *   或后续前端配置界面的“重载”按钮）从文件重新加载，无需重启服务
 * API 修改（add/update/remove/setActive）写文件并即时更新内存，不依赖 reload
 */
export class ModelConfigStore {
  private connections: ModelConnection[];
  private activeConnectionId: string | null;

  constructor(private readonly filePath: string) {
    const loaded = this.load();
    this.connections = loaded.connections;
    this.activeConnectionId = loaded.activeConnectionId;
  }

  /** 从磁盘重新加载 model.json（覆盖内存）；文件不存在/被删除视为空态。 */
  reload(): ModelConfigState {
    const loaded = this.load();
    this.connections = loaded.connections;
    this.activeConnectionId = loaded.activeConnectionId;
    return this.list();
  }

  list(): ModelConfigState {
    return {
      connections: this.connections.map((connection) => toSummary(connection)),
      activeConnectionId: this.activeConnectionId
    };
  }

  getConnection(id: string): ModelConnection | undefined {
    return this.connections.find((connection) => connection.id === id);
  }

  /** 当前活动连接的完整参数；未配置时返回 undefined。 */
  resolveConnection(): ModelConnection | undefined {
    if (!this.activeConnectionId) {
      return undefined;
    }
    return this.getConnection(this.activeConnectionId);
  }

  add(input: NewModelConnectionInput): ModelConnection {
    const missing = REQUIRED_FIELDS.filter((field) => !input[field]?.trim());
    if (missing.length) {
      throw new Error(`Model connection is missing required fields: ${missing.join(", ")}.`);
    }
    const connection: ModelConnection = {
      id: input.id?.trim() || crypto.randomUUID(),
      name: input.name.trim(),
      provider: input.provider.trim(),
      model: input.model.trim(),
      baseUrl: input.baseUrl.trim()
    };
    const apiKey = input.apiKey?.trim();
    if (apiKey) {
      connection.apiKey = apiKey;
    }
    if (this.connections.some((existing) => existing.id === connection.id)) {
      throw new Error(`Model connection ${connection.id} already exists`);
    }
    this.connections.push(connection);
    if (!this.activeConnectionId) {
      // 首个连接自动设为活动连接
      this.activeConnectionId = connection.id;
    }
    this.persist();
    return connection;
  }

  update(id: string, input: UpdateModelConnectionInput): ModelConnection | undefined {
    const index = this.connections.findIndex((connection) => connection.id === id);
    if (index === -1) {
      return undefined;
    }
    const current = this.connections[index] as ModelConnection;
    const next: ModelConnection = {
      ...current,
      name: input.name?.trim() || current.name,
      provider: input.provider?.trim() || current.provider,
      model: input.model?.trim() || current.model,
      baseUrl: input.baseUrl?.trim() || current.baseUrl
    };
    if (input.apiKey !== undefined) {
      const apiKey = input.apiKey.trim();
      if (apiKey) {
        next.apiKey = apiKey;
      } else {
        delete next.apiKey;
      }
    }
    const missing = REQUIRED_FIELDS.filter((field) => !next[field]?.trim());
    if (missing.length) {
      throw new Error(`Model connection is missing required fields: ${missing.join(", ")}.`);
    }
    this.connections[index] = next;
    this.persist();
    return next;
  }

  remove(id: string): boolean {
    const index = this.connections.findIndex((connection) => connection.id === id);
    if (index === -1) {
      return false;
    }
    this.connections.splice(index, 1);
    if (this.activeConnectionId === id) {
      // 删除活动连接后自动转移到剩余的第一个连接
      this.activeConnectionId = this.connections[0]?.id ?? null;
    }
    this.persist();
    return true;
  }

  setActive(id: string): ModelConnection | undefined {
    if (!this.connections.some((connection) => connection.id === id)) {
      return undefined;
    }
    this.activeConnectionId = id;
    this.persist();
    return this.getConnection(id);
  }

  /** 基座聚合用：当前活动连接状态摘要。 */
  status(): {
    configured: boolean;
    provider: string;
    model: string;
    baseUrl?: string;
    connections: number;
    activeConnectionId: string | null;
  } {
    const active = this.resolveConnection();
    const status = {
      configured: false,
      provider: "",
      model: "",
      connections: this.connections.length,
      activeConnectionId: this.activeConnectionId
    };
    if (active && missingModelConfig(active).length === 0) {
      status.configured = true;
      status.provider = active.provider;
      status.model = active.model;
      if (active.baseUrl) {
        return { ...status, baseUrl: active.baseUrl };
      }
    }
    return status;
  }

  private load(): PersistedModelConfig {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
    } catch (error) {
      if (isMissingFileError(error)) {
        return { connections: [], activeConnectionId: null };
      }
      throw new Error(`Failed to parse model config: ${this.filePath}`, { cause: error });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid model config: ${this.filePath}`);
    }
    const raw = parsed as Partial<PersistedModelConfig>;
    const connections = Array.isArray(raw.connections) ? raw.connections : [];
    const activeConnectionId = typeof raw.activeConnectionId === "string" ? raw.activeConnectionId : null;
    return {
      connections,
      activeConnectionId: activeConnectionId && connections.some((c) => c.id === activeConnectionId)
        ? activeConnectionId
        : null
    };
  }

  private persist(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: PersistedModelConfig = {
      connections: this.connections,
      activeConnectionId: this.activeConnectionId
    };
    writeFileSync(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}

export function missingModelConfig(connection: Pick<ModelConnection, "model" | "baseUrl">): string[] {
  return [
    connection.model?.trim() ? undefined : "model",
    connection.baseUrl?.trim() ? undefined : "baseUrl"
  ].filter((item): item is string => Boolean(item));
}

export function isModelConfigured(connection: ModelConnection | undefined): boolean {
  return Boolean(connection && missingModelConfig(connection).length === 0);
}

function toSummary(connection: ModelConnection): ModelConnectionSummary {
  return {
    id: connection.id,
    name: connection.name,
    provider: connection.provider,
    model: connection.model,
    baseUrl: connection.baseUrl,
    apiKeySet: Boolean(connection.apiKey)
  };
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
