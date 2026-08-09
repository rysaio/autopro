import { describe, expect, it } from "vitest";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult
} from "@ai-sdk/provider";
import type { AgentRunEvent } from "@secops-agent/shared";
import { buildServer } from "../src/app.js";
import { scriptedModelForRequest, testConfig } from "./fixtures/testConfig.js";

describe("agent run event stream", () => {
  it("streams run lifecycle events and final run payload", async () => {
    const app = buildServer(testConfig({
      SECOPS_ACTION_LEVEL: "sandbox",
      SECOPS_DURABLE_SESSIONS: "on",
      SECOPS_DATA_DIR: "memory://"
    }), { createModel: scriptedModelForRequest });
    const sessionId = "session-sse-metrics";

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/events",
      headers: { origin: "http://localhost:5317" },
      payload: {
        sessionId,
        messages: [
          {
            role: "user",
            content: "Investigate suspicious IOC 198.51.100.23 for a defensive case."
          }
        ],
        enabledTools: ["ioc.enrich"],
        permissionMode: "auto"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5317");
    expect(response.body).toContain("event: run_started");
    expect(response.body).toContain("event: audit");
    expect(response.body).toContain("event: tool");
    expect(response.body).toContain("event: text_delta");
    expect(response.body).toContain("event: message");
    expect(response.body).toContain("event: run_completed");
    expect(response.body).toContain('"status":"completed"');
    expect(response.body).toContain('"toolName":"ioc.enrich"');
    expect(response.body).toContain('"sessionId"');
    const events = response.body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)));
    const completionEvent = events.find((event) => event.type === "run_completed");
    const textDelta = events.find((event) => event.type === "text_delta");
    const finalMessage = events.find((event) => event.type === "message" && event.message.role === "assistant");
    expect(textDelta?.delta.length).toBeGreaterThan(0);
    expect(finalMessage?.message.id).toBe(textDelta?.messageId);
    expect(events.indexOf(textDelta)).toBeLessThan(events.indexOf(finalMessage));
    expect(events.indexOf(finalMessage)).toBeLessThan(events.indexOf(completionEvent));
    expect(completionEvent?.run.metrics.measurementBoundary).toBe("before-completion-export");
    expect(completionEvent?.run.routing).toMatchObject({
      mode: "deterministic",
      selectedToolIds: ["ioc.enrich"],
      additionalModelStage: { used: false }
    });
    expect(completionEvent?.run.metrics.model).toMatchObject({
      requestCount: 2,
      requests: [{ phase: "final" }, { phase: "final" }]
    });
    const restored = await app.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().runs[0].metrics).toEqual(completionEvent.run.metrics);
    expect(restored.json().runs[0].lastEvent.run.metrics).toEqual(completionEvent.run.metrics);

    await app.close();
  }, 15_000);

  it("keeps pending approval, text, final message, and completion events ordered", async () => {
    const app = buildServer(testConfig({
      SECOPS_ACTION_LEVEL: "sandbox",
      SECOPS_DURABLE_SESSIONS: "on",
      SECOPS_DATA_DIR: "memory://"
    }), {
      createModel: scriptedModelForRequest,
      enableLayeredRouting: false
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/events",
      payload: {
        messages: [{ role: "user", content: "Write note for this security case." }],
        enabledTools: ["case.note.write"],
        permissionMode: "ask"
      }
    });
    const events = response.body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)));
    const approval = events.find((event) => event.type === "tool" && event.invocation.status === "pending_approval");
    const textDelta = events.find((event) => event.type === "text_delta");
    const finalMessage = events.find((event) => event.type === "message" && event.message.role === "assistant");
    const completion = events.find((event) => event.type === "run_completed");

    expect(response.statusCode).toBe(200);
    expect(approval).toBeDefined();
    expect(events.indexOf(approval)).toBeLessThan(events.indexOf(textDelta));
    expect(events.indexOf(textDelta)).toBeLessThan(events.indexOf(finalMessage));
    expect(events.indexOf(finalMessage)).toBeLessThan(events.indexOf(completion));
    expect(completion.run.status).toBe("needs_approval");
    expect(completion.run.terminalReason).toContain("approval");

    await app.close();
  });

  it("cancels an active run through HTTP and keeps the SSE connection through terminal state", async () => {
    const app = buildServer(testConfig({
      SECOPS_DURABLE_SESSIONS: "off",
      SECOPS_AGENT_RUN_TIMEOUT_MS: "10000"
    }), {
      createModel: () => new BlockingSseModel(),
      enableLayeredRouting: false
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected an assigned TCP port.");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/api/agent/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Start a cancellable investigation." }],
        enabledTools: []
      })
    });
    expect(response.status).toBe(200);
    expect(response.body).not.toBeNull();

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events: AgentRunEvent[] = [];
    while (!events.some((event) => event.type === "text_delta")) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      buffer += decoder.decode(chunk.value, { stream: true });
      const drained = drainEvents(buffer);
      buffer = drained.remainder;
      events.push(...drained.events);
    }
    const runStarted = events.find((event) => event.type === "run_started");
    expect(runStarted).toBeDefined();

    const cancellation = await fetch(`http://127.0.0.1:${address.port}/api/agent/runs/${runStarted!.runId}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "cancelled" })
    });
    expect(cancellation.status).toBe(200);
    expect(await cancellation.json()).toMatchObject({ status: "cancelled" });

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const drained = drainEvents(buffer);
      buffer = drained.remainder;
      events.push(...drained.events);
    }
    buffer += decoder.decode();
    const drained = drainEvents(`${buffer}\n\n`);
    events.push(...drained.events);
    const completion = events.find((event) => event.type === "run_completed");
    const delta = events.find((event) => event.type === "text_delta");
    const finalMessage = events.find((event) => event.type === "message" && event.message.role === "assistant");
    expect(completion?.run.status).toBe("cancelled");
    expect(completion?.run.terminalReason).toContain("analyst");
    expect(finalMessage?.message.id).toBe(delta?.messageId);
    expect(events.at(-1)?.type).toBe("run_completed");

    await app.close();
  }, 15_000);
});

class BlockingSseModel implements LanguageModelV3 {
  readonly specificationVersion = "v3";
  readonly provider = "test-provider";
  readonly modelId = "blocking-sse-model";
  readonly supportedUrls = {};

  async doGenerate(_options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    throw new Error("BlockingSseModel only supports streaming");
  }

  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    return {
      stream: new ReadableStream({
        start(controller) {
          const textId = "blocking-sse-text";
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({ type: "text-start", id: textId });
          controller.enqueue({ type: "text-delta", id: textId, delta: "Initial streamed evidence." });
          const abort = () => controller.error(options.abortSignal?.reason ?? new Error("aborted"));
          if (options.abortSignal?.aborted) {
            abort();
          } else {
            options.abortSignal?.addEventListener("abort", abort, { once: true });
          }
        }
      })
    };
  }
}

function drainEvents(input: string): { remainder: string; events: AgentRunEvent[] } {
  const chunks = input.replace(/\r\n/g, "\n").split("\n\n");
  const remainder = chunks.pop() ?? "";
  const events = chunks.flatMap((chunk) => {
    const data = chunk
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length))
      .join("\n");
    return data ? [JSON.parse(data) as AgentRunEvent] : [];
  });
  return { remainder, events };
}
