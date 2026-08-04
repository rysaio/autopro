import { createHash } from "node:crypto";

/**
 * 语义工具结果缓存 (Semantic Tool Result Cache)
 *
 * 创新点：按工具名+参数哈希缓存执行结果，避免重复 LLM 推理和工具调用。
 * 感知类工具（perception）结果稳定性高，缓存 5 分钟；
 * 推理类（reasoning）需适中新鲜度，缓存 1 分钟；
 * 动作类（action）不可缓存，因为会改变系统状态。
 */

export type ToolCacheCategory = "perception" | "reasoning" | "evidence" | "action";

interface CacheEntry {
  result: unknown;
  artifacts: unknown[];
  createdAt: number;
  ttlMs: number;
}

const TTL_MAP: Record<ToolCacheCategory, number> = {
  perception: 5 * 60 * 1000,   // 5 分钟：资产、IOC、威胁情报查询结果稳定
  reasoning: 1 * 60 * 1000,     // 1 分钟：检测规则、MITRE 搜索可短时复用
  evidence: 30 * 1000,          // 30 秒：报告生成短时有效
  action: 0                     // 0 = 不可缓存：写操作/执行动作必须实时
};

export interface ToolCacheStats {
  hits: number;
  misses: number;
  size: number;
  savedTokensEstimate: number;
}

export class ToolCache {
  private readonly store = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  private savedTokens = 0;

  /** 生成缓存键：工具名 + 参数排序后哈希 */
  static key(toolName: string, args: Record<string, unknown>): string {
    const sorted = Object.keys(args)
      .sort()
      .reduce((acc, k) => {
        acc[k] = args[k];
        return acc;
      }, {} as Record<string, unknown>);
    const hash = createHash("md5").update(JSON.stringify(sorted)).digest("hex").slice(0, 12);
    return `${toolName}:${hash}`;
  }

  /** 尝试命中缓存，返回 null 表示未命中 */
  get(toolName: string, args: Record<string, unknown>): { result: unknown; artifacts: unknown[] } | null {
    const key = ToolCache.key(toolName, args);
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (Date.now() - entry.createdAt > entry.ttlMs) {
      this.store.delete(key);
      this.misses++;
      return null;
    }
    this.hits++;
    // 估算节省的 token 数（平均每个工具结果 ~200 tokens）
    this.savedTokens += 200;
    return { result: entry.result, artifacts: entry.artifacts };
  }

  /** 写入缓存 */
  set(
    toolName: string,
    args: Record<string, unknown>,
    category: ToolCacheCategory,
    result: unknown,
    artifacts: unknown[] = []
  ): void {
    const ttlMs = TTL_MAP[category];
    if (ttlMs === 0) return; // action 类不缓存
    const key = ToolCache.key(toolName, args);
    this.store.set(key, {
      result,
      artifacts,
      createdAt: Date.now(),
      ttlMs
    });
  }

  /** 使指定工具的缓存失效（如状态变更后） */
  invalidate(toolNamePrefix?: string): void {
    if (!toolNamePrefix) {
      this.store.clear();
      return;
    }
    for (const key of this.store.keys()) {
      if (key.startsWith(toolNamePrefix)) {
        this.store.delete(key);
      }
    }
  }

  /** 使所有 action 类工具的缓存失效（状态变更后调用） */
  invalidateAfterAction(): void {
    // action 类本身不缓存，但 action 执行后可能影响感知工具结果
    // 清除所有感知类缓存以确保数据新鲜度
    // 保守策略：清除全部缓存
    this.store.clear();
  }

  /** 缓存统计 */
  stats(): ToolCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.store.size,
      savedTokensEstimate: this.savedTokens
    };
  }

  /** 命中率 */
  hitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : this.hits / total;
  }

  /** 清理过期条目 */
  prune(): number {
    let removed = 0;
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now - entry.createdAt > entry.ttlMs) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }
}