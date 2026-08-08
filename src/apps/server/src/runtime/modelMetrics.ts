import type {
  AgentModelMetrics,
  AgentModelRequestMetrics,
  AgentModelUsageMetrics
} from "@secops-agent/shared";
import type {
  LanguageModelV2,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
  LanguageModelV3,
  LanguageModelV3StreamResult,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage
} from "@ai-sdk/provider";
import { wrapLanguageModel, type LanguageModel } from "ai";

type ModelPhase = AgentModelRequestMetrics["phase"];
type StreamPart = LanguageModelV2StreamPart | LanguageModelV3StreamPart;

export class ModelMetricsRecorder {
  private readonly requests: AgentModelRequestMetrics[] = [];
  private measurable = false;

  wrap(model: LanguageModel, phase: ModelPhase, exposedToolCount: number): LanguageModel {
    if (typeof model !== "object" || model === null) {
      return model;
    }
    this.measurable = true;
    if (model.specificationVersion === "v2") {
      return this.wrapV2(model, phase, exposedToolCount);
    }
    return wrapLanguageModel({
      model,
      middleware: {
        specificationVersion: "v3",
        wrapGenerate: ({ doGenerate }) => this.measureGenerate(
          doGenerate,
          phase,
          exposedToolCount,
          (result) => ({
            finishReason: result.finishReason.unified,
            usage: v3Usage(result.usage)
          })
        ),
        wrapStream: ({ doStream }) => this.measureStream<LanguageModelV3StreamPart, LanguageModelV3StreamResult>(
          doStream,
          phase,
          exposedToolCount,
          (part) => ({
            finishReason: part.finishReason.unified,
            usage: v3Usage(part.usage)
          })
        )
      }
    });
  }

  snapshot(): AgentModelMetrics {
    if (!this.measurable) {
      return { measurement: "unavailable", requests: [] };
    }
    return {
      measurement: "provider-attempts",
      requestCount: this.requests.length,
      totalDurationMs: roundedMs(this.requests.reduce((total, request) => total + request.durationMs, 0)),
      retryCount: retryCount(this.requests),
      requests: [...this.requests]
    };
  }

  private wrapV2(model: LanguageModelV2, phase: ModelPhase, exposedToolCount: number): LanguageModelV2 {
    return {
      specificationVersion: model.specificationVersion,
      provider: model.provider,
      modelId: model.modelId,
      supportedUrls: model.supportedUrls,
      doGenerate: (options) => this.measureGenerate(
        () => model.doGenerate(options),
        phase,
        exposedToolCount,
        (result) => ({
          finishReason: result.finishReason,
          usage: v2Usage(result.usage)
        })
      ),
      doStream: (options) => this.measureStream<
        LanguageModelV2StreamPart,
        Awaited<ReturnType<LanguageModelV2["doStream"]>>
      >(
        () => model.doStream(options),
        phase,
        exposedToolCount,
        (part) => ({
          finishReason: part.finishReason,
          usage: v2Usage(part.usage)
        })
      )
    };
  }

  private async measureGenerate<Result>(
    generate: () => PromiseLike<Result>,
    phase: ModelPhase,
    exposedToolCount: number,
    metrics: (result: Result) => { finishReason: string; usage: AgentModelUsageMetrics }
  ): Promise<Result> {
    const startedAt = performance.now();
    try {
      const result = await generate();
      const measured = metrics(result);
      this.recordCompleted(
        phase,
        exposedToolCount,
        startedAt,
        measured.finishReason,
        measured.usage
      );
      return result;
    } catch (error) {
      this.recordFailed(phase, exposedToolCount, startedAt);
      throw error;
    }
  }

  private async measureStream<
    Part extends StreamPart,
    Result extends { stream: ReadableStream<Part> }
  >(
    stream: () => PromiseLike<Result>,
    phase: ModelPhase,
    exposedToolCount: number,
    metrics: (part: Extract<Part, { type: "finish" }>) => {
      finishReason: string;
      usage: AgentModelUsageMetrics;
    }
  ): Promise<Result> {
    const startedAt = performance.now();
    try {
      const result = await stream();
      return {
        ...result,
        stream: observeStream(result.stream, {
          onFinish: (part) => {
            const measured = metrics(part);
            this.recordCompleted(
              phase,
              exposedToolCount,
              startedAt,
              measured.finishReason,
              measured.usage
            );
          },
          onFailure: () => this.recordFailed(phase, exposedToolCount, startedAt)
        })
      };
    } catch (error) {
      this.recordFailed(phase, exposedToolCount, startedAt);
      throw error;
    }
  }

  private recordCompleted(
    phase: ModelPhase,
    exposedToolCount: number,
    startedAt: number,
    finishReason: string,
    usage: AgentModelUsageMetrics
  ): void {
    this.requests.push({
      phase,
      durationMs: elapsedMs(startedAt),
      exposedToolCount,
      outcome: "completed",
      finishReason,
      usage
    });
  }

  private recordFailed(phase: ModelPhase, exposedToolCount: number, startedAt: number): void {
    this.requests.push({
      phase,
      durationMs: elapsedMs(startedAt),
      exposedToolCount,
      outcome: "failed",
      usage: {}
    });
  }
}

function observeStream<Part extends StreamPart>(
  stream: ReadableStream<Part>,
  observer: {
    onFinish: (part: Extract<Part, { type: "finish" }>) => void;
    onFailure: () => void;
  }
): ReadableStream<Part> {
  const reader = stream.getReader();
  let recorded = false;
  return new ReadableStream<Part>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          if (!recorded) {
            recorded = true;
            observer.onFailure();
          }
          controller.close();
          return;
        }
        if (next.value.type === "finish") {
          recorded = true;
          observer.onFinish(next.value as Extract<Part, { type: "finish" }>);
        }
        controller.enqueue(next.value);
      } catch (error) {
        if (!recorded) {
          recorded = true;
          observer.onFailure();
        }
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    }
  });
}

function retryCount(requests: AgentModelRequestMetrics[]): number {
  const failedAttempts = requests.filter((request) => request.outcome === "failed").length;
  const terminalFailure = requests.at(-1)?.outcome === "failed" ? 1 : 0;
  return Math.max(0, failedAttempts - terminalFailure);
}

function v3Usage(usage: LanguageModelV3Usage): AgentModelUsageMetrics {
  const metrics: AgentModelUsageMetrics = {};
  setNumber(metrics, "inputTokens", usage.inputTokens.total);
  setNumber(metrics, "outputTokens", usage.outputTokens.total);
  setNumber(metrics, "totalTokens", tokenTotal(usage));
  setNumber(metrics, "cacheReadTokens", usage.inputTokens.cacheRead);
  setNumber(metrics, "cacheWriteTokens", usage.inputTokens.cacheWrite);
  setNumber(metrics, "reasoningTokens", usage.outputTokens.reasoning);
  return metrics;
}

function v2Usage(usage: LanguageModelV2Usage): AgentModelUsageMetrics {
  const metrics: AgentModelUsageMetrics = {};
  setNumber(metrics, "inputTokens", usage.inputTokens);
  setNumber(metrics, "outputTokens", usage.outputTokens);
  setNumber(metrics, "totalTokens", usage.totalTokens);
  setNumber(metrics, "cacheReadTokens", usage.cachedInputTokens);
  setNumber(metrics, "reasoningTokens", usage.reasoningTokens);
  return metrics;
}

function tokenTotal(usage: LanguageModelV3Usage): number | undefined {
  if (usage.inputTokens.total === undefined || usage.outputTokens.total === undefined) {
    return undefined;
  }
  return usage.inputTokens.total + usage.outputTokens.total;
}

function setNumber(
  target: AgentModelUsageMetrics,
  key: keyof AgentModelUsageMetrics,
  value: number | undefined
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function elapsedMs(startedAt: number): number {
  return roundedMs(performance.now() - startedAt);
}

function roundedMs(value: number): number {
  return Math.round(value * 100) / 100;
}
