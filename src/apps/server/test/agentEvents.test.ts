import { describe, expect, it } from "vitest";
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
    expect(response.body).toContain("event: run_started");
    expect(response.body).toContain("event: audit");
    expect(response.body).toContain("event: tool");
    expect(response.body).toContain("event: message");
    expect(response.body).toContain("event: run_completed");
    expect(response.body).toContain('"status":"completed"');
    expect(response.body).toContain('"toolName":"ioc.enrich"');
    expect(response.body).toContain('"sessionId"');
    const completionEvent = response.body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)))
      .find((event) => event.type === "run_completed");
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
  });
});
