import { createHash } from "node:crypto";
import type { LanguageModel } from "ai";
import type { ModelClientLifecycleMetrics } from "@secops-agent/shared";
import type { ModelConnection } from "./modelConfigStore.js";

/**
 * 模型客户端生命周期缓存（Issue #9）。
 *
 * 业界依据：OpenAI SDK / AI SDK 的 provider client 是无状态工厂产物，
 * 相同连接配置下的连续与并发请求可以安全共享同一个 LanguageModel 实例
 * （provider SDK 支持的生命周期），无需每次 agent run 重建。
 *
 * 语义：
 * - 缓存键 = 连接 id + 配置指纹（provider/model/baseUrl/apiKey 的 SHA-256，
 *   指纹不可逆，日志与快照绝不包含明文密钥或授权头）。
 * - 引用计数：acquire 返回绑定条目的 release 闭包（不是按 id 递减），
 *   因此配置变更后新旧条目各自独立归零，绝不会把一次 release 记到别的
 *   条目上；被替换/失效的条目在活跃引用归零前不释放（延迟清理）。
 * - provider 暴露清理操作（disposeModel）时才真正关闭旧 client。
 * - 指标：按连接 id 累计创建、复用、失效、创建失败、释放，与模型请求时长分开。
 */
export interface ModelClientCacheOptions {
  createModel: (connection: ModelConnection) => LanguageModel;
  /** provider 暴露清理操作时提供；否则跳过关闭。 */
  disposeModel?: (model: LanguageModel) => void | Promise<void>;
}

export interface ModelClientAcquisition {
  model: LanguageModel;
  /** 本次获取是否复用了已有 client。 */
  reused: boolean;
  /** 释放对该 client 的持有；必须且只能调用一次。 */
  release: () => void;
}

interface ConnectionTotals {
  connectionId: string;
  created: number;
  reused: number;
  invalidated: number;
  creationFailures: number;
  disposed: number;
}

interface CacheEntry {
  connectionId: string;
  fingerprint: string;
  model: LanguageModel;
  activeRuns: number;
  /** 配置已变更/已失效，禁止后续复用；等待活跃引用归零后释放。 */
  invalidated: boolean;
  disposed: boolean;
}

export class ModelClientCache {
  /** 每个连接当前可复用的最新条目。 */
  private readonly entries = new Map<string, CacheEntry>();
  /** 已被替换/失效、仍有活跃引用、等待归零后释放的旧条目。 */
  private readonly retired: CacheEntry[] = [];
  private readonly connectionTotals = new Map<string, ConnectionTotals>();
  private readonly totals = {
    created: 0,
    reused: 0,
    invalidated: 0,
    creationFailures: 0,
    disposed: 0
  };
  private closed = false;

  constructor(private readonly options: ModelClientCacheOptions) {}

  /** 获取（并持有）与连接配置匹配的模型 client。run 结束后必须调用返回的 release。 */
  acquire(connection: ModelConnection): ModelClientAcquisition {
    if (this.closed) {
      throw new Error("Model client cache is closed.");
    }
    const fingerprint = fingerprintConnection(connection);
    const existing = this.entries.get(connection.id);
    if (existing && !existing.invalidated && !existing.disposed && existing.fingerprint === fingerprint) {
      existing.activeRuns += 1;
      this.connectionTotal(connection.id).reused += 1;
      this.totals.reused += 1;
      return {
        model: existing.model,
        reused: true,
        release: () => this.releaseEntry(existing)
      };
    }
    // 配置变更或条目已失效：创建新 client。旧条目若仍被活跃 run 使用，
    // 标记失效并转入 retired，等待其引用归零后再释放。
    let model: LanguageModel;
    try {
      model = this.options.createModel(connection);
    } catch (error) {
      this.connectionTotal(connection.id).creationFailures += 1;
      this.totals.creationFailures += 1;
      throw error;
    }
    const entry: CacheEntry = {
      connectionId: connection.id,
      fingerprint,
      model,
      activeRuns: 1,
      invalidated: false,
      disposed: false
    };
    if (existing) {
      this.supersede(existing);
    }
    this.entries.set(connection.id, entry);
    this.connectionTotal(connection.id).created += 1;
    this.totals.created += 1;
    return {
      model,
      reused: false,
      release: () => this.releaseEntry(entry)
    };
  }

  /** 使一个连接的缓存失效（配置更新/删除时）。无活跃使用时立即释放。 */
  invalidate(connectionId: string): void {
    const entry = this.entries.get(connectionId);
    if (!entry || entry.invalidated) {
      return;
    }
    entry.invalidated = true;
    this.connectionTotal(connectionId).invalidated += 1;
    this.totals.invalidated += 1;
    if (entry.activeRuns === 0) {
      this.entries.delete(connectionId);
      void this.evictEntry(entry);
    }
  }

  /** 使全部连接缓存失效（配置整体重载时）。 */
  invalidateAll(): void {
    for (const connectionId of [...this.entries.keys()]) {
      this.invalidate(connectionId);
    }
  }

  /** 服务器关闭：释放并关闭所有缓存的 client，之后缓存不可再用。 */
  async dispose(): Promise<void> {
    this.closed = true;
    const all = [...this.entries.values(), ...this.retired];
    this.entries.clear();
    this.retired.length = 0;
    for (const entry of all) {
      await this.evictEntry(entry);
    }
    this.connectionTotals.clear();
  }

  snapshot(): ModelClientLifecycleMetrics {
    const activeByConnection = new Map<string, number>();
    for (const entry of this.entries.values()) {
      if (!entry.disposed) {
        activeByConnection.set(entry.connectionId, entry.activeRuns);
      }
    }
    const connections = [...this.connectionTotals.values()].map((total) => ({
      ...total,
      active: activeByConnection.get(total.connectionId) ?? 0
    }));
    return {
      connections,
      totalCreated: this.totals.created,
      totalReused: this.totals.reused,
      totalInvalidated: this.totals.invalidated,
      totalCreationFailures: this.totals.creationFailures,
      totalDisposed: this.totals.disposed
    };
  }

  /** 条目被替换：若仍被活跃 run 使用则转入 retired，否则立即释放。 */
  private supersede(entry: CacheEntry): void {
    entry.invalidated = true;
    if (entry.activeRuns > 0) {
      this.retired.push(entry);
      return;
    }
    void this.evictEntry(entry);
  }

  private releaseEntry(entry: CacheEntry): void {
    if (entry.disposed || entry.activeRuns <= 0) {
      return;
    }
    entry.activeRuns -= 1;
    if (!entry.invalidated || entry.activeRuns > 0) {
      return;
    }
    // 失效且引用归零：从最新条目或 retired 中移除并释放
    if (this.entries.get(entry.connectionId) === entry) {
      this.entries.delete(entry.connectionId);
    } else {
      const index = this.retired.indexOf(entry);
      if (index !== -1) {
        this.retired.splice(index, 1);
      }
    }
    void this.evictEntry(entry);
  }

  private connectionTotal(connectionId: string): ConnectionTotals {
    let total = this.connectionTotals.get(connectionId);
    if (!total) {
      total = {
        connectionId,
        created: 0,
        reused: 0,
        invalidated: 0,
        creationFailures: 0,
        disposed: 0
      };
      this.connectionTotals.set(connectionId, total);
    }
    return total;
  }

  private async evictEntry(entry: CacheEntry): Promise<void> {
    if (entry.disposed) {
      return;
    }
    entry.disposed = true;
    this.connectionTotal(entry.connectionId).disposed += 1;
    this.totals.disposed += 1;
    if (this.options.disposeModel) {
      try {
        await this.options.disposeModel(entry.model);
      } catch {
        // 清理失败不阻塞缓存状态机；释放计数已记录
      }
    }
  }
}

/** 配置指纹：参与 apiKey 以识别鉴权修订，但指纹是 SHA-256 摘要，不泄露明文。 */
export function fingerprintConnection(connection: Pick<ModelConnection, "provider" | "model" | "baseUrl" | "apiKey">): string {
  return createHash("sha256")
    .update([
      connection.provider ?? "",
      connection.model ?? "",
      connection.baseUrl ?? "",
      connection.apiKey ?? ""
    ].join("\u0000"))
    .digest("hex");
}
