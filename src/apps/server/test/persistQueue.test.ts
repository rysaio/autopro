import { describe, expect, it, vi } from "vitest";
import { PersistQueue, PersistQueueRegistry } from "../src/runtime/persistQueue.js";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("PersistQueue", () => {
  it("does not wait for an individual storage write on the emit path", async () => {
    const writes: string[] = [];
    const queue = new PersistQueue({ flushIntervalMs: 5 });
    const op = () => {
      writes.push("write");
      return Promise.resolve();
    };

    const pending = queue.enqueue(op);
    // 入队后立即返回：同步路径上写入尚未发生
    expect(writes).toEqual([]);

    await pending;
    expect(writes).toEqual(["write"]);
  });

  it("preserves FIFO order within a run", async () => {
    const order: string[] = [];
    const queue = new PersistQueue({ flushIntervalMs: 5 });
    const results = await Promise.all(
      ["a", "b", "c", "d", "e"].map((label) => queue.enqueue(async () => {
        await tick(1);
        order.push(label);
      }))
    );

    expect(results).toHaveLength(5);
    expect(order).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("batches operations up to batchSize and counts batch writes", async () => {
    const queue = new PersistQueue({ batchSize: 2, flushIntervalMs: 5 });
    await Promise.all(Array.from({ length: 3 }, (_, index) => queue.enqueue(async () => {
      await tick(index === 0 ? 3 : 1);
    })));
    await queue.drain(1000);

    const snapshot = queue.snapshot();
    expect(snapshot.enqueued).toBe(3);
    expect(snapshot.completed).toBe(3);
    expect(snapshot.batchWriteCount).toBe(2);
    expect(snapshot.batchWriteDurationMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.failed).toBe(0);
  });

  it("applies bounded backpressure at saturation and rejects after the wait window", async () => {
    const queue = new PersistQueue({
      capacity: 1,
      batchSize: 1,
      flushIntervalMs: 5,
      saturationWaitMs: 40
    });
    // 第一个操作挂起 → 队列占满
    const stuck = queue.enqueue(() => new Promise(() => {}));
    await tick(10);

    // 第二个操作进入有界等待，超过 saturationWaitMs 后失败
    const rejected = queue.enqueue(async () => {});
    await expect(rejected).rejects.toThrow(/saturated/);
    expect(stuck).toBeInstanceOf(Promise);

    const snapshot = queue.snapshot();
    expect(snapshot.saturationCount).toBe(1);
    expect(snapshot.failed).toBe(1);
    expect(snapshot.maxDepth).toBe(1);
  });

  it("surfaces storage failures without dropping later operations", async () => {
    const queue = new PersistQueue({ flushIntervalMs: 5 });
    const executed: string[] = [];

    const failing = queue.enqueue(async () => {
      executed.push("fail");
      throw new Error("storage boom");
    });
    const following = queue.enqueue(async () => {
      executed.push("ok");
    });

    await expect(failing).rejects.toThrow("storage boom");
    await following;
    expect(executed).toEqual(["fail", "ok"]);

    const snapshot = queue.snapshot();
    expect(snapshot.failed).toBe(1);
    expect(snapshot.completed).toBe(1);
    expect(snapshot.enqueued).toBe(2);
  });

  it("drains within a bounded time and reports remaining work on timeout", async () => {
    const queue = new PersistQueue({ flushIntervalMs: 5 });
    queue.enqueue(() => new Promise(() => {})); // 永不完成

    const result = await queue.drain(40);
    expect(result.drainTimedOut).toBe(true);
    expect(result.remainingOperations).toBe(1);
    expect(result.drainDurationMs).toBeGreaterThanOrEqual(40);
    // 超时不丢弃剩余操作（仍在 in-flight 中，不占队列深度）
    expect(queue.depth()).toBe(0);
  });

  it("drains successfully when all operations finish", async () => {
    const queue = new PersistQueue({ flushIntervalMs: 5 });
    const writes: string[] = [];
    queue.enqueue(async () => {
      writes.push("a");
    });
    queue.enqueue(async () => {
      writes.push("b");
    });

    const result = await queue.drain(1000);
    expect(result.drainTimedOut).toBe(false);
    expect(result.remainingOperations).toBe(0);
    expect(writes).toEqual(["a", "b"]);
  });

  it("tracks queue wait and depth metrics", async () => {
    const queue = new PersistQueue({ flushIntervalMs: 20 });
    queue.enqueue(async () => {
      await tick(5);
    });
    queue.enqueue(async () => {
      await tick(5);
    });
    queue.enqueue(async () => {
      await tick(5);
    });

    await queue.drain(1000);
    const snapshot = queue.snapshot();
    expect(snapshot.maxDepth).toBe(3);
    expect(snapshot.queueWaitDurationMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.drainDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("rejects enqueue after dispose", async () => {
    const queue = new PersistQueue({ flushIntervalMs: 5 });
    await queue.dispose(100);
    await expect(queue.enqueue(async () => {})).rejects.toThrow(/closed/);
  });

  it("registry drains all registered queues and clears them", async () => {
    const registry = new PersistQueueRegistry();
    const first = new PersistQueue({ flushIntervalMs: 5 });
    const second = new PersistQueue({ flushIntervalMs: 5 });
    registry.register(first);
    registry.register(second);

    first.enqueue(async () => {});
    second.enqueue(async () => {});

    const results = await registry.drainAll(1000);
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.drainTimedOut === false)).toBe(true);
    expect(results.every((result) => result.completed === 1)).toBe(true);
    expect(registry.size).toBe(0);
  });

  it("keeps per-run metrics isolated between queue instances", async () => {
    const first = new PersistQueue({ flushIntervalMs: 5 });
    const second = new PersistQueue({ flushIntervalMs: 5 });
    await Promise.all([first.enqueue(async () => {}), first.enqueue(async () => {})]);
    await second.enqueue(async () => {});
    await first.drain(1000);
    await second.drain(1000);

    expect(first.snapshot().enqueued).toBe(2);
    expect(second.snapshot().enqueued).toBe(1);
    expect(vi.isMockFunction(first.snapshot)).toBe(false);
  });
});
