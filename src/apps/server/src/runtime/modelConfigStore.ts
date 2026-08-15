import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ModelConfigState, ModelConnectionSummary } from "@secops-agent/shared";
import { CredentialStore, maskSecret } from "./credentialStore.js";

/**
 * 完整模型连接（含运行时解析出的明文 apiKey）。仅存在于服务端内存中，永不通过 API 下发。
 * settings/model.json 只持久化 apiKeyCredentialId 凭据引用；明文只写入 .credentials.yaml。
 */
export interface ModelConnection {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  /** 运行时解析出的明文密钥；仅服务端内存使用。 */
  apiKey?: string;
  /** 凭据引用 id，指向 .credentials.yaml 中的条目。 */
  apiKeyCredentialId?: string;
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

interface PersistedModelConnection {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  /** 新格式：凭据引用。 */
  apiKeyCredentialId?: string;
  /** 旧格式兼容：明文 apiKey，load 时自动迁移到凭据文件。 */
  apiKey?: string;
}

interface PersistedModelConfig {
  connections: PersistedModelConnection[];
  activeConnectionId: string | null;
}

const REQUIRED_FIELDS = ["name", "provider", "model", "baseUrl"] as const;

/**
 * 模型配置热存储：model.json 是连接与活动连接的唯一事实来源，凭据文件是密钥的唯一事实来源。
 * - 启动前：直接编辑 model.json（引用凭据 id）与 .credentials.yaml，启动时读取
 * - 启动后：直接编辑文件，再调用 reload()（后端 POST /api/model-config/reload）从磁盘重新加载
 * - API 修改（add/update/remove/setActive）写 model.json 并即时更新内存；写 apiKey 时
 *   只把明文写入凭据文件，model.json 仅保存凭据引用，API 响应只回传脱敏描述符
 */
export class ModelConfigStore {
  private connections: ModelConnection[];
  private activeConnectionId: string | null;
  private readonly credentialStore: CredentialStore;

  constructor(
    private readonly filePath: string,
    credentialsPath = path.join(path.dirname(filePath), ".credentials.yaml")
  ) {
    this.credentialStore = new CredentialStore(credentialsPath);
    const loaded = this.load();
    this.connections = loaded.connections;
    this.activeConnectionId = loaded.activeConnectionId;
  }

  /** 从磁盘重新加载 model.json 与 .credentials.yaml（覆盖内存）；文件不存在/被删除视为空态。 */
  reload(): ModelConfigState {
    this.credentialStore.reload();
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
      connection.apiKeyCredentialId = this.credentialStore.create(
        apiKey,
        `Model API key for ${connection.name}`
      );
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
        next.apiKeyCredentialId = this.credentialStore.update(
          current.apiKeyCredentialId,
          apiKey,
          `Model API key for ${next.name}`
        );
        next.apiKey = apiKey;
      } else {
        this.credentialStore.delete(current.apiKeyCredentialId);
        delete next.apiKey;
        delete next.apiKeyCredentialId;
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
    const removed = this.connections[index] as ModelConnection;
    this.connections.splice(index, 1);
    if (removed.apiKeyCredentialId && !this.connections.some((connection) => connection.apiKeyCredentialId === removed.apiKeyCredentialId)) {
      this.credentialStore.delete(removed.apiKeyCredentialId);
    }
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
    const rawConnections = Array.isArray(raw.connections) ? raw.connections : [];
    const connections: ModelConnection[] = [];
    let migrated = false;
    for (const entry of rawConnections) {
      const connection = toModelConnection(entry);
      if (!connection) {
        continue;
      }
      const apiKeyCredentialId = typeof entry.apiKeyCredentialId === "string" && entry.apiKeyCredentialId.trim()
        ? entry.apiKeyCredentialId.trim()
        : undefined;
      const legacyApiKey = typeof entry.apiKey === "string" ? entry.apiKey.trim() : "";
      if (apiKeyCredentialId) {
        connection.apiKeyCredentialId = apiKeyCredentialId;
        const secret = this.credentialStore.getSecret(apiKeyCredentialId);
        if (secret !== undefined) {
          connection.apiKey = secret;
        }
      } else if (legacyApiKey) {
        // 旧格式兼容：明文 apiKey 自动迁移到凭据文件，model.json 改写为凭据引用。
        const credentialId = this.credentialStore.create(
          legacyApiKey,
          `Imported from model.json for ${connection.name}`
        );
        connection.apiKeyCredentialId = credentialId;
        connection.apiKey = legacyApiKey;
        migrated = true;
      }
      connections.push(connection);
    }
    const activeConnectionId = typeof raw.activeConnectionId === "string" && connections.some((connection) => connection.id === raw.activeConnectionId)
      ? raw.activeConnectionId
      : null;
    if (migrated) {
      this.persist(connections, activeConnectionId);
    }
    return { connections, activeConnectionId };
  }

  private persist(
    connections = this.connections,
    activeConnectionId = this.activeConnectionId
  ): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload: PersistedModelConfig = {
      connections: connections.map(toPersistedConnection),
      activeConnectionId
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
    apiKeySet: Boolean(connection.apiKey),
    ...(connection.apiKey ? { apiKeyMasked: maskSecret(connection.apiKey) } : {})
  };
}

function toPersistedConnection(connection: ModelConnection): PersistedModelConnection {
  const { apiKey: _apiKey, apiKeyCredentialId, ...rest } = connection;
  return {
    ...rest,
    ...(apiKeyCredentialId ? { apiKeyCredentialId } : {})
  };
}

function toModelConnection(entry: unknown): ModelConnection | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return undefined;
  }
  const raw = entry as Record<string, unknown>;
  if (
    typeof raw.id !== "string" ||
    typeof raw.name !== "string" ||
    typeof raw.provider !== "string" ||
    typeof raw.model !== "string" ||
    typeof raw.baseUrl !== "string"
  ) {
    return undefined;
  }
  return {
    id: raw.id,
    name: raw.name,
    provider: raw.provider,
    model: raw.model,
    baseUrl: raw.baseUrl
  };
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
