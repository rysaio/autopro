import { describe, expect, it } from "vitest";
import { ToolCache, type ToolCacheKeyInput } from "../src/runtime/toolCache.js";

describe("ToolCache", () => {
  it("canonicalizes nested object keys recursively while preserving arrays and values", () => {
    const left = key({
      query: {
        filters: { severity: "high", source: "edr" },
        indicators: ["alpha", "beta"]
      }
    });
    const reordered = key({
      query: {
        indicators: ["alpha", "beta"],
        filters: { source: "edr", severity: "high" }
      }
    });
    const differentArray = key({
      query: {
        filters: { source: "edr", severity: "high" },
        indicators: ["beta", "alpha"]
      }
    });

    expect(ToolCache.key(left)).toBe(ToolCache.key(reordered));
    expect(ToolCache.key(left)).not.toBe(ToolCache.key(differentArray));
    expect(ToolCache.key(key({ value: -0 }))).not.toBe(ToolCache.key(key({ value: 0 })));
    expect(ToolCache.key(key({ value: undefined }))).not.toBe(ToolCache.key(key({})));
  });

  it("expires entries and cleans them up on lookup", () => {
    let now = 1_000;
    const cache = new ToolCache({ now: () => now });
    cache.set(key({ indicator: "198.51.100.1" }), value("source-1"), 50);

    now = 1_049;
    expect(cache.get(key({ indicator: "198.51.100.1" })).status).toBe("hit");
    now = 1_050;
    expect(cache.get(key({ indicator: "198.51.100.1" }))).toMatchObject({ status: "miss", expiredEntries: 1 });
    expect(cache.stats()).toMatchObject({ size: 0, expiredEntries: 1 });
  });

  it("evicts the least recently used entry at a deterministic capacity bound", () => {
    const cache = new ToolCache({ maxEntries: 2, now: () => 1_000 });
    const first = key({ indicator: "first" });
    const second = key({ indicator: "second" });
    const third = key({ indicator: "third" });
    cache.set(first, value("source-1"), 1_000);
    cache.set(second, value("source-2"), 1_000);

    expect(cache.get(first).status).toBe("hit");
    expect(cache.set(third, value("source-3"), 1_000).evictions).toBe(1);

    expect(cache.get(second).status).toBe("miss");
    expect(cache.get(first).status).toBe("hit");
    expect(cache.get(third).status).toBe("hit");
    expect(cache.stats()).toMatchObject({ size: 2, maxEntries: 2, evictions: 1 });
  });
});

function key(args: Record<string, unknown>): ToolCacheKeyInput {
  return {
    toolId: "test.lookup",
    toolVersion: "1",
    dataSource: "test-source",
    workspaceRoot: "C:\\workspace",
    args
  };
}

function value(sourceInvocationId: string) {
  return {
    result: { ok: true },
    artifacts: [],
    sourceInvocationId,
    handlerDurationMs: 12
  };
}
