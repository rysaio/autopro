import { describe, expect, it } from "vitest";
import {
  calculateLocalOrchestrationDurationMs,
  mergeTimingIntervals,
  RunTimingRecorder
} from "../src/runtime/runTimingRecorder.js";

describe("RunTimingRecorder", () => {
  it("merges overlapping and adjacent external wait intervals", () => {
    expect(mergeTimingIntervals([
      { startedAtMs: 30, completedAtMs: 70 },
      { startedAtMs: 10, completedAtMs: 50 },
      { startedAtMs: 80, completedAtMs: 90 },
      { startedAtMs: 90, completedAtMs: 95 },
      { startedAtMs: 40, completedAtMs: 45 }
    ])).toEqual([
      { startedAtMs: 10, completedAtMs: 70 },
      { startedAtMs: 80, completedAtMs: 95 }
    ]);
  });

  it("subtracts the union of provider, tool, and persistence waits", () => {
    expect(calculateLocalOrchestrationDurationMs(0, 100, [
      { startedAtMs: 10, completedAtMs: 50 },
      { startedAtMs: 30, completedAtMs: 70 },
      { startedAtMs: 80, completedAtMs: 90 }
    ])).toBe(30);
  });

  it("uses only numeric monotonic clock samples", () => {
    const readings = [0, 10, 30, 50, 70, 80, 90, 100];
    const recorder = new RunTimingRecorder(() => readings.shift() ?? 100);
    const provider = recorder.start("provider");
    const persistence = recorder.start("persistence");
    expect(provider.end()).toBe(40);
    expect(persistence.end()).toBe(40);
    const tool = recorder.start("tool");
    expect(tool.end()).toBe(10);
    expect(recorder.totalDurationMs("provider")).toBe(40);
    expect(recorder.totalDurationMs("persistence")).toBe(40);
    expect(recorder.totalDurationMs("tool")).toBe(10);
    expect(recorder.snapshot()).toEqual({
      totalDurationMs: 100,
      localOrchestrationDurationMs: 30
    });
  });
});
