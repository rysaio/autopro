import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface PluginCachePolicy {
  enabled: boolean;
  ttlMs: number;
}

/** Keyed by tool manifest id (e.g. `demo.query`). Missing entry = caching disabled. */
export type PluginCachePolicies = Record<string, PluginCachePolicy>;

/** 缓存 TTL 上限：24 小时，防止误设近永久缓存。 */
export const MAX_PLUGIN_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Host-owned, persisted opt-in cache policy for plugin tools.
 * A plugin tool is never cached until an explicit policy enables it; MCP
 * read-only/idempotence annotations may reject an unsafe policy but never
 * enable caching on their own.
 */
export class PluginCachePolicyStore {
  private policies: PluginCachePolicies;

  constructor(private readonly filePath: string) {
    this.policies = this.load();
  }

  get(): PluginCachePolicies {
    return { ...this.policies };
  }

  policyFor(manifestId: string): PluginCachePolicy | undefined {
    const policy = this.policies[manifestId];
    return policy ? { ...policy } : undefined;
  }

  set(manifestId: string, policy: PluginCachePolicy): void {
    if (!manifestId) {
      throw new Error("Plugin cache policy requires a tool manifest id");
    }
    if (typeof policy.enabled !== "boolean") {
      throw new Error("Plugin cache policy enabled must be a boolean");
    }
    if (!Number.isInteger(policy.ttlMs) || policy.ttlMs <= 0 || policy.ttlMs > MAX_PLUGIN_CACHE_TTL_MS) {
      throw new Error(`Plugin cache policy ttlMs must be a positive integer no greater than ${MAX_PLUGIN_CACHE_TTL_MS}`);
    }
    this.policies = { ...this.policies, [manifestId]: { enabled: policy.enabled, ttlMs: policy.ttlMs } };
    this.persist();
  }

  clear(manifestId: string): boolean {
    if (!Object.hasOwn(this.policies, manifestId)) {
      return false;
    }
    const next = { ...this.policies };
    delete next[manifestId];
    this.policies = next;
    this.persist();
    return true;
  }

  private load(): PluginCachePolicies {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
    } catch (error) {
      if (isMissingFileError(error)) {
        return {};
      }
      throw error;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid plugin cache policy config: ${this.filePath}`);
    }
    const result: PluginCachePolicies = {};
    for (const [manifestId, raw] of Object.entries(parsed as Record<string, unknown>)) {
      // 防御本地篡改的策略文件中的原型污染键（__proto__/constructor）
      if (manifestId === "__proto__" || manifestId === "constructor" || manifestId === "prototype") {
        throw new Error(`Invalid plugin cache policy config: ${this.filePath}`);
      }
      if (!manifestId || !raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`Invalid plugin cache policy config: ${this.filePath}`);
      }
      const policy = raw as Partial<PluginCachePolicy>;
      if (typeof policy.enabled !== "boolean" || !Number.isInteger(policy.ttlMs) || (policy.ttlMs as number) <= 0) {
        throw new Error(`Invalid plugin cache policy config: ${this.filePath}`);
      }
      result[manifestId] = { enabled: policy.enabled, ttlMs: policy.ttlMs as number };
    }
    return result;
  }

  private persist(): void {
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(this.policies, null, 2)}\n`, "utf8");
  }
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
