export type RunTimingCategory = "provider" | "tool" | "persistence";

export interface TimingInterval {
  startedAtMs: number;
  completedAtMs: number;
}

interface RecordedTimingInterval extends TimingInterval {
  category: RunTimingCategory;
}

export interface RunTimingSnapshot {
  totalDurationMs: number;
  localOrchestrationDurationMs: number;
}

export interface RunTimingSpan {
  end(): number;
}

export class RunTimingRecorder {
  private readonly runStartedAtMs: number;
  private readonly intervals: RecordedTimingInterval[] = [];

  constructor(private readonly clock: () => number = () => performance.now()) {
    this.runStartedAtMs = clock();
  }

  start(category: RunTimingCategory): RunTimingSpan {
    const startedAtMs = this.clock();
    let durationMs: number | undefined;
    return {
      end: () => {
        if (durationMs !== undefined) {
          return durationMs;
        }
        const completedAtMs = this.clock();
        durationMs = Math.max(0, completedAtMs - startedAtMs);
        this.recordInterval(category, startedAtMs, completedAtMs);
        return durationMs;
      }
    };
  }

  elapsedMs(): number {
    return roundDurationMs(Math.max(0, this.clock() - this.runStartedAtMs));
  }

  totalDurationMs(category: RunTimingCategory): number {
    return roundDurationMs(this.intervals
      .filter((interval) => interval.category === category)
      .reduce((total, interval) => total + interval.completedAtMs - interval.startedAtMs, 0));
  }

  snapshot(): RunTimingSnapshot {
    const completedAtMs = this.clock();
    const totalDurationMs = Math.max(0, completedAtMs - this.runStartedAtMs);
    return {
      totalDurationMs: roundDurationMs(totalDurationMs),
      localOrchestrationDurationMs: roundDurationMs(calculateLocalOrchestrationDurationMs(
        this.runStartedAtMs,
        completedAtMs,
        this.intervals
      ))
    };
  }

  private recordInterval(
    category: RunTimingCategory,
    startedAtMs: number,
    completedAtMs: number
  ): void {
    if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs) || completedAtMs < startedAtMs) {
      return;
    }
    this.intervals.push({ category, startedAtMs, completedAtMs });
  }
}

export function calculateLocalOrchestrationDurationMs(
  runStartedAtMs: number,
  runCompletedAtMs: number,
  externalWaitIntervals: TimingInterval[]
): number {
  const totalDurationMs = Math.max(0, runCompletedAtMs - runStartedAtMs);
  const boundedIntervals = externalWaitIntervals.flatMap((interval) => {
    const startedAtMs = Math.max(runStartedAtMs, interval.startedAtMs);
    const completedAtMs = Math.min(runCompletedAtMs, interval.completedAtMs);
    return completedAtMs > startedAtMs ? [{ startedAtMs, completedAtMs }] : [];
  });
  const externalWaitDurationMs = mergeTimingIntervals(boundedIntervals)
    .reduce((total, interval) => total + interval.completedAtMs - interval.startedAtMs, 0);
  return Math.max(0, totalDurationMs - externalWaitDurationMs);
}

export function mergeTimingIntervals(intervals: TimingInterval[]): TimingInterval[] {
  const sorted = intervals
    .filter((interval) => (
      Number.isFinite(interval.startedAtMs)
      && Number.isFinite(interval.completedAtMs)
      && interval.completedAtMs >= interval.startedAtMs
    ))
    .map((interval) => ({ ...interval }))
    .sort((left, right) => (
      left.startedAtMs - right.startedAtMs || left.completedAtMs - right.completedAtMs
    ));
  const merged: TimingInterval[] = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (!previous || interval.startedAtMs > previous.completedAtMs) {
      merged.push(interval);
      continue;
    }
    previous.completedAtMs = Math.max(previous.completedAtMs, interval.completedAtMs);
  }
  return merged;
}

export function roundDurationMs(value: number): number {
  return Math.round(value * 100) / 100;
}
