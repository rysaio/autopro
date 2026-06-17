import { describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { scriptedModelForRequest, testConfig } from "./fixtures/testConfig.js";

describe("agent run event stream", () => {
  it("streams run lifecycle events and final run payload", async () => {
    const app = buildServer(testConfig({
      SECOPS_ACTION_LEVEL: "sandbox"
    }), { createModel: scriptedModelForRequest });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/events",
      payload: {
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

    await app.close();
  });
});
