import { roundDurationMs } from "./runTimingRecorder.js";

/**
 * 有界、有序、异步批处理持久化队列（Issue #10）。
 *
 * 设计依据（业界标准做法）：
 * - 有界容量 + 单消费者：等价于 tokio `mpsc::channel(capacity)`——有界通道满时
 *   send 等待（背压），单 receiver 保证消息顺序。
 *   https://docs.rs/tokio/latest/tokio/sync/mpsc/index.html
 * - 有界阻塞背压：饱和时 enqueue 等待至多 `saturationWaitMs`（类比 Kafka producer
 *   `buffer.memory` + `max.block.ms`），超时后以失败呈现（指标 + 调用方 audit 状态），
 *   关键记录不静默丢弃。
 * - 干净关闭：先 close（拒绝新操作）再排空到空（tokio 的 "clean shutdown" 语义），
 *   排空带超时上限，超时显式报告剩余工作。
 *
 * 语义：
 * - 入队立即返回（不等待单次存储写入），flush 在定时器/批大小阈值触发；
 * - 同一队列内严格 FIFO，每次 run 一个队列 → 每次 run 内事件顺序保持；
 * - 指标区分：队列等待、批写入时长、失败、深度、饱和、排空时长。
 */
export interface PersistQueueOptions {
  /** 队列容量上限（默认 512）。 */
  capacity?: number;
  /** 单批最大操作数（默认 32）。 */
  batchSize?: number;
  /** 延迟合并窗口：入队后等待该时长再刷出第一批（默认 20ms）。 */
  flushIntervalMs?: number;
  /** drain 超时（默认 5000ms）。 */
  drainTimeoutMs?: number;
  /** 饱和时背压等待上限（默认 1000ms）。 */
  saturationWaitMs?: number;
  clock?: () => number;
}

export interface PersistQueueSnapshot {
  /** 队列中尚未开始写入的操作数。 */
  depth: number;
  /** 历史累计指标（drain 后保留）。 */
  enqueued: number;
  completed: number;
  failed: number;
  batchWriteCount: number;
  batchWriteDurationMs: number;
  queueWaitDurationMs: number;
  maxDepth: number;
  saturationCount: number;
  drainDurationMs: number;
  drainTimedOut: boolean;
  remainingOperations: number;
}

interface QueueItem {
  operation: () => Promise<void>;
  enqueuedAtMs: number;
  startedAtMs?: number;
  resolve: () => void;
  reject: (error: unknown) => void;
  settled: boolean;
  promise: Promise<void>;
}

const DEFAULT_CAPACITY = 512;
const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_FLUSH_INTERVAL_MS = 20;
const DEFAULT_DRAIN_TIMEOUT_MS = 5000;
const DEFAULT_SATURATION_WAIT_MS = 1000;
const POLL_INTERVAL_MS = 5;

export class PersistQueue {
  private readonly items: QueueItem[] = [];
  private readonly capacity: number;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly drainTimeoutMs: number;
  private readonly saturationWaitMs: number;
  private readonly clock: () => number;

  private closed = false;
  private flushing = false;
  private inFlight = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  private readonly metrics = {
    enqueued: 0,
    completed: 0,
    failed: 0,
    batchWriteCount: 0,
    batchWriteDurationMs: 0,
    queueWaitDurationMs: 0,
    maxDepth: 0,
    saturationCount: 0,
    drainDurationMs: 0,
    drainTimedOut: false,
    remainingOperations: 0
  };

  constructor(options: PersistQueueOptions = {}) {
    this.capacity = positive(options.capacity, DEFAULT_CAPACITY);
    this.batchSize = positive(options.batchSize, DEFAULT_BATCH_SIZE);
    this.flushIntervalMs = nonNegative(options.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS);
    this.drainTimeoutMs = positive(options.drainTimeoutMs, DEFAULT_DRAIN_TIMEOUT_MS);
    this.saturationWaitMs = nonNegative(options.saturationWaitMs, DEFAULT_SATURATION_WAIT_MS);
    this.clock = options.clock ?? (() => performance.now());
  }

  /**
   * 入队一个存储操作。立即返回 promise（不等待写入本身）。
   * 队列满时应用有界背压：等待至多 saturationWaitMs，超时后 reject
   * （记录饱和与失败，由调用方通过指标/审计状态呈现，不静默丢弃）。
   */
  async enqueue(operation: () => Promise<void>): Promise<void> {
    if (this.closed) {
      throw new Error("Persist queue is closed.");
    }
    const item = createQueueItem(operation, this.clock());
    if (this.pendingCount() < this.capacity) {
      this.pushItem(item);
      return item.promise;
    }
    // 饱和：有界背压等待
    this.metrics.saturationCount += 1;
    const deadlineMs = this.clock() + this.saturationWaitMs;
    while (this.pendingCount() >= this.capacity) {
      const remainingMs = deadlineMs - this.clock();
      if (remainingMs <= 0) {
        this.metrics.failed += 1;
        item.reject(new Error(
          `Persist queue saturated: ${this.capacity} operations pending for over ${this.saturationWaitMs} ms.`
        ));
        return item.promise;
      }
      await sleep(Math.min(POLL_INTERVAL_MS, remainingMs));
      if (this.closed) {
        item.reject(new Error("Persist queue closed while waiting for capacity."));
        return item.promise;
      }
    }
    this.pushItem(item);
    return item.promise;
  }

  /** 当前待写入操作数。 */
  depth(): number {
    return this.items.length;
  }

  /**
   * 有界排空：等待当前所有已入队操作完成。超时后不丢弃剩余操作，
   * 而是显式报告剩余数量与超时状态（drainTimedOut/remainingOperations）。
   * 队列保持可继续入队（调用方应停止入队后再排空）。
   */
  async drain(timeoutMs?: number): Promise<PersistQueueSnapshot> {
    const startedAtMs = this.clock();
    const deadlineMs = startedAtMs + (timeoutMs ?? this.drainTimeoutMs);
    while (this.pendingCount() > 0) {
      const remainingMs = deadlineMs - this.clock();
      if (remainingMs <= 0) {
        this.metrics.drainTimedOut = true;
        this.metrics.remainingOperations = this.pendingCount();
        this.metrics.drainDurationMs = roundDurationMs(this.clock() - startedAtMs);
        return this.snapshot();
      }
      // flush 由入队调度；drain 期间同样推进 flush
      this.scheduleFlush();
      await sleep(Math.min(POLL_INTERVAL_MS, remainingMs));
    }
    this.metrics.drainTimedOut = false;
    this.metrics.remainingOperations = 0;
    this.metrics.drainDurationMs = roundDurationMs(this.clock() - startedAtMs);
    return this.snapshot();
  }

  /** 关闭队列：拒绝新入队并执行一次有界排空（服务器关闭语义）。 */
  async dispose(timeoutMs?: number): Promise<PersistQueueSnapshot> {
    this.closed = true;
    return this.drain(timeoutMs);
  }

  snapshot(): PersistQueueSnapshot {
    return {
      depth: this.items.length,
      enqueued: this.metrics.enqueued,
      completed: this.metrics.completed,
      failed: this.metrics.failed,
      batchWriteCount: this.metrics.batchWriteCount,
      batchWriteDurationMs: roundDurationMs(this.metrics.batchWriteDurationMs),
      queueWaitDurationMs: roundDurationMs(this.metrics.queueWaitDurationMs),
      maxDepth: this.metrics.maxDepth,
      saturationCount: this.metrics.saturationCount,
      drainDurationMs: roundDurationMs(this.metrics.drainDurationMs),
      drainTimedOut: this.metrics.drainTimedOut,
      remainingOperations: this.metrics.remainingOperations
    };
  }

  private pushItem(item: QueueItem): void {
    this.items.push(item);
    this.metrics.enqueued += 1;
    this.metrics.maxDepth = Math.max(this.metrics.maxDepth, this.items.length);
    this.scheduleFlush();
  }

  /** 延迟合并调度：批大小足够立即刷出，否则等 flushIntervalMs 窗口。 */
  private scheduleFlush(): void {
    if (this.flushing) {
      return;
    }
    if (this.timer !== undefined) {
      return;
    }
    if (this.items.length >= this.batchSize) {
      this.timer = setTimeout(() => this.flush(), 0);
      return;
    }
    this.timer = setTimeout(() => this.flush(), this.flushIntervalMs);
  }

  private async flush(): Promise<void> {
    this.timer = undefined;
    if (this.flushing || this.items.length === 0) {
      return;
    }
    this.flushing = true;
    try {
      while (this.items.length > 0) {
        const batch = this.items.splice(0, Math.min(this.batchSize, this.items.length));
        this.inFlight += batch.length;
        const batchStartedAtMs = this.clock();
        try {
          for (const item of batch) {
            item.startedAtMs = this.clock();
            this.metrics.queueWaitDurationMs += item.startedAtMs - item.enqueuedAtMs;
            try {
              await item.operation();
              item.settled = true;
              item.resolve();
              this.metrics.completed += 1;
            } catch (error) {
              item.settled = true;
              item.reject(error);
              this.metrics.failed += 1;
            }
          }
        } finally {
          this.inFlight -= batch.length;
        }
        this.metrics.batchWriteCount += 1;
        this.metrics.batchWriteDurationMs += this.clock() - batchStartedAtMs;
      }
    } finally {
      this.flushing = false;
      if (this.items.length > 0) {
        this.scheduleFlush();
      }
    }
  }

  private pendingCount(): number {
    return this.items.length + this.inFlight;
  }
}

/** 活跃队列注册表：run 注册、结束注销；服务器关闭时统一有界排空。 */
export class PersistQueueRegistry {
  private readonly queues = new Set<PersistQueue>();

  register(queue: PersistQueue): void {
    this.queues.add(queue);
  }

  unregister(queue: PersistQueue): void {
    this.queues.delete(queue);
  }

  get size(): number {
    return this.queues.size;
  }

  /** 对每个注册队列执行有界排空（服务器关闭路径）。 */
  async drainAll(timeoutMs?: number): Promise<PersistQueueSnapshot[]> {
    const results: PersistQueueSnapshot[] = [];
    for (const queue of [...this.queues]) {
      results.push(await queue.dispose(timeoutMs));
    }
    this.queues.clear();
    return results;
  }
}

function createQueueItem(operation: () => Promise<void>, enqueuedAtMs: number): QueueItem {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { operation, enqueuedAtMs, resolve, reject, promise, settled: false };
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : fallback;
}

function nonNegative(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) >= 0 ? (value as number) : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
