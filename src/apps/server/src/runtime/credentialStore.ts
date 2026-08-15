import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * 只写凭据存储：明文只进 .credentials.yaml，settings/model.json 只保留凭据引用。
 * - 页面/API 永不回传明文，仅回传 maskSecret 生成的脱敏描述符（如 sk-***abc）。
 * - 文件尽量以 0600 权限创建/写回，限制本机其他用户读取。
 */
export interface CredentialRecord {
  secret: string;
  description?: string;
  createdAt?: string;
}


export class CredentialStore {
  private credentials: Record<string, CredentialRecord>;

  constructor(private readonly filePath: string) {
    this.credentials = this.load();
  }

  /** 从磁盘重新加载凭据文件；文件不存在/被删除视为空凭据库。 */
  reload(): void {
    this.credentials = this.load();
  }

  has(id: string): boolean {
    return id in this.credentials;
  }

  getSecret(id: string): string | undefined {
    return this.credentials[id]?.secret;
  }

  /** 写入新密钥，返回凭据引用 id。 */
  create(secret: string, description?: string): string {
    const id = `cred_${crypto.randomUUID()}`;
    this.credentials[id] = {
      secret,
      ...(description?.trim() ? { description: description.trim() } : {}),
      createdAt: new Date().toISOString()
    };
    this.persist();
    return id;
  }

  /** 覆盖已有凭据中的密钥；引用不存在时新建一个。 */
  update(id: string | undefined, secret: string, description?: string): string {
    const targetId = id && this.credentials[id] ? id : this.create(secret, description);
    const record = this.credentials[targetId] as CredentialRecord;
    record.secret = secret;
    if (description?.trim()) {
      record.description = description.trim();
    }
    record.createdAt ??= new Date().toISOString();
    this.persist();
    return targetId;
  }

  delete(id: string | undefined): boolean {
    if (!id || !this.credentials[id]) {
      return false;
    }
    delete this.credentials[id];
    this.persist();
    return true;
  }

  /** 凭据引用的脱敏描述符；引用不存在或密钥为空时返回 undefined。 */
  mask(id: string): string | undefined {
    const secret = this.getSecret(id);
    return secret ? maskSecret(secret) : undefined;
  }

  private load(): Record<string, CredentialRecord> {
    let text: string;
    try {
      text = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        return {};
      }
      throw new Error(`Failed to read credentials file: ${this.filePath}`, { cause: error });
    }
    if (!text.trim()) {
      return {};
    }
    const parsed = parseYaml(text) as unknown;
    if (parsed === null || parsed === undefined) {
      return {};
    }
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid credentials file: ${this.filePath}`);
    }
    const rawCredentials = (parsed as { credentials?: unknown }).credentials;
    if (rawCredentials === undefined || rawCredentials === null) {
      return {};
    }
    if (typeof rawCredentials !== "object" || Array.isArray(rawCredentials)) {
      throw new Error(`Invalid credentials file: ${this.filePath}`);
    }
    const result: Record<string, CredentialRecord> = {};
    for (const [id, record] of Object.entries(rawCredentials as Record<string, unknown>)) {
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        throw new Error(`Invalid credential entry in ${this.filePath}: ${id}`);
      }
      const candidate = record as Partial<CredentialRecord>;
      if (typeof candidate.secret !== "string") {
        throw new Error(`Invalid credential entry in ${this.filePath}: ${id} (secret is required)`);
      }
      result[id] = {
        secret: candidate.secret,
        ...(typeof candidate.description === "string" ? { description: candidate.description } : {}),
        ...(typeof candidate.createdAt === "string" ? { createdAt: candidate.createdAt } : {})
      };
    }
    return result;
  }

  private persist(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const yaml = stringifyYaml({ credentials: this.credentials });
    writeFileSync(this.filePath, yaml, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") {
      chmodSync(this.filePath, 0o600);
    }
  }
}

/**
 * 生成脱敏描述符，例如 "sk-***abc"。
 * - 长度 <= 6：只保留首尾字符，中间用 *** 代替。
 * - 长度 > 6：保留前 3 个字符与后 3 个字符，中间用 *** 代替。
 */
export function maskSecret(secret: string): string {
  const value = secret.trim();
  if (!value) {
    return "****";
  }
  if (value.length <= 6) {
    return `${value[0]}***${value[value.length - 1]}`;
  }
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
