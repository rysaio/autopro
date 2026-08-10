import { createHash } from "node:crypto";
import type { EvidenceArtifact } from "@secops-agent/shared";

export interface ToolCacheKeyInput {
  toolId: string;
  toolVersion: string;
  dataSource: string;
  workspaceRoot: string;
  args: Record<string, unknown>;
  /** Host-owned isolation scope (e.g. `plugin:<pluginId>`); included in the key. */
  namespace?: string;
}

export interface ToolCacheValue {
  result: unknown;
  artifacts: EvidenceArtifact[];
  sourceInvocationId: string;
  handlerDurationMs: number;
}

interface CacheEntry extends ToolCacheValue {
  createdAt: number;
  expiresAt: number;
  /** Host isolation scope recorded at write time so reload/removal can reclaim entries. */
  namespace?: string;
}

export type ToolCacheLookup =
  | {
      status: "hit";
      value: ToolCacheValue;
      originalCreatedAt: string;
      ageMs: number;
      expiredEntries: number;
    }
  | {
      status: "miss";
      expiredEntries: number;
    };

export interface ToolCacheWriteResult {
  stored: boolean;
  evictions: number;
  expiredEntries: number;
}

export interface ToolCacheStats {
  hits: number;
  misses: number;
  evictions: number;
  expiredEntries: number;
  invalidatedEntries: number;
  size: number;
  maxEntries: number;
}

export interface ToolCacheOptions {
  maxEntries?: number;
  now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 256;

/** Service-lifetime, capacity-bounded LRU for explicitly cacheable tool results. */
export class ToolCache {
  private readonly store = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expiredEntries = 0;
  private invalidatedEntries = 0;

  constructor(options: ToolCacheOptions = {}) {
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("Tool cache maxEntries must be a positive integer");
    }
    this.maxEntries = maxEntries;
    this.now = options.now ?? Date.now;
  }

  static key(input: ToolCacheKeyInput): string {
    const canonical = stableSerialize({
      ...(input.namespace ? { namespace: input.namespace } : {}),
      toolId: input.toolId,
      toolVersion: input.toolVersion,
      dataSource: input.dataSource,
      workspaceRoot: input.workspaceRoot,
      args: input.args
    });
    return createHash("sha256").update(canonical).digest("hex");
  }

  get(input: ToolCacheKeyInput): ToolCacheLookup {
    const now = this.now();
    const expiredEntries = this.pruneAt(now);
    const key = ToolCache.key(input);
    const entry = this.store.get(key);
    if (!entry) {
      this.misses += 1;
      return { status: "miss", expiredEntries };
    }

    this.store.delete(key);
    this.store.set(key, entry);
    this.hits += 1;
    return {
      status: "hit",
      value: cloneValue(entry),
      originalCreatedAt: new Date(entry.createdAt).toISOString(),
      ageMs: Math.max(0, now - entry.createdAt),
      expiredEntries
    };
  }

  set(input: ToolCacheKeyInput, value: ToolCacheValue, ttlMs: number): ToolCacheWriteResult {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      return { stored: false, evictions: 0, expiredEntries: 0 };
    }

    const now = this.now();
    const expiredEntries = this.pruneAt(now);
    const key = ToolCache.key(input);
    let cloned: ToolCacheValue;
    try {
      cloned = cloneValue(value);
    } catch {
      return { stored: false, evictions: 0, expiredEntries };
    }

    this.store.delete(key);
    this.store.set(key, {
      ...cloned,
      createdAt: now,
      expiresAt: now + ttlMs,
      ...(input.namespace ? { namespace: input.namespace } : {})
    });

    let evictions = 0;
    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        break;
      }
      this.store.delete(oldestKey);
      evictions += 1;
      this.evictions += 1;
    }
    return { stored: true, evictions, expiredEntries };
  }

  invalidateAll(): number {
    const removed = this.store.size;
    this.store.clear();
    this.invalidatedEntries += removed;
    return removed;
  }

  /** Immediately reclaim every entry recorded under the given host namespace. */
  invalidateNamespace(namespace: string): number {
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (entry.namespace === namespace) {
        this.store.delete(key);
        removed += 1;
      }
    }
    this.invalidatedEntries += removed;
    return removed;
  }

  prune(): number {
    return this.pruneAt(this.now());
  }

  stats(): ToolCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expiredEntries: this.expiredEntries,
      invalidatedEntries: this.invalidatedEntries,
      size: this.store.size,
      maxEntries: this.maxEntries
    };
  }

  private pruneAt(now: number): number {
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (now >= entry.expiresAt) {
        this.store.delete(key);
        removed += 1;
      }
    }
    this.expiredEntries += removed;
    return removed;
  }
}

export function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `array:[${value.map(stableSerialize).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSerialize(item)}`);
    return `object:{${entries.join(",")}}`;
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "number:NaN";
    if (value === Number.POSITIVE_INFINITY) return "number:Infinity";
    if (value === Number.NEGATIVE_INFINITY) return "number:-Infinity";
    if (Object.is(value, -0)) return "number:-0";
    return `number:${value}`;
  }
  if (typeof value === "bigint") {
    return `bigint:${value}`;
  }
  if (typeof value === "string") {
    return `string:${JSON.stringify(value)}`;
  }
  if (typeof value === "boolean") {
    return `boolean:${value}`;
  }
  if (value === undefined) {
    return "undefined";
  }
  throw new Error(`Unsupported cache key value: ${typeof value}`);
}

function cloneValue(value: ToolCacheValue | CacheEntry): ToolCacheValue {
  return structuredClone({
    result: value.result,
    artifacts: value.artifacts,
    sourceInvocationId: value.sourceInvocationId,
    handlerDurationMs: value.handlerDurationMs
  });
}
