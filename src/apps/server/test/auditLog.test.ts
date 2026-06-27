import { rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { scriptedModelForRequest, testConfig } from "./fixtures/testConfig.js";

describe("runtime audit log", () => {
  it("persists agent run events and exposes recent events", async () => {
    const auditRoot = path.resolve("runtime/audit-log-test");
    await rm(auditRoot, { recursive: true, force: true });
    const app = buildServer(testConfig({
      SECOPS_ACTION_LEVEL: "sandbox",
      SECOPS_AUDIT_LOG_PATH: path.join(auditRoot, "events.jsonl")
    }), { createModel: scriptedModelForRequest });

    const runResponse = await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: {
        messages: [
          {
            role: "user",
            content: "Investigate suspicious IOC 198.51.100.23 for a defensive case."
          }
        ],
        enabledTools: ["ioc.enrich"]
      }
    });
    expect(runResponse.statusCode).toBe(200);

    const auditResponse = await app.inject({
      method: "GET",
      url: "/api/audit/events?limit=20"
    });
    expect(auditResponse.statusCode).toBe(200);
    const events = auditResponse.json().events;
    expect(events.map((event: { type: string }) => event.type)).toContain("run_started");
    expect(events.map((event: { type: string }) => event.type)).toContain("tool");
    expect(events.at(-1).type).toBe("run_completed");

    await app.close();
    await rm(auditRoot, { recursive: true, force: true });
  });
});
