import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { scriptedModelForRequest, testConfig } from "./fixtures/testConfig.js";

describe("agent request validation", () => {
  it("requires at least one user message for run APIs", async () => {
    const app = buildServer(testConfig({
    }));

    const empty = await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: {
        messages: []
      }
    });
    expect(empty.statusCode).toBe(400);

    const assistantOnly = await app.inject({
      method: "POST",
      url: "/api/agent/events",
      payload: {
        messages: [
          {
            role: "assistant",
            content: "I should not start an agent run by myself."
          }
        ]
      }
    });
    expect(assistantOnly.statusCode).toBe(400);

    await app.close();
  });

  it("falls back to ask mode for invalid client-supplied permission mode", async () => {
    const sandboxRoot = path.resolve("runtime/agent-invalid-permission-sandbox");
    const approvalStorePath = path.resolve("runtime/agent-invalid-permission-approvals/pending.json");
    await rm(sandboxRoot, { recursive: true, force: true });
    await rm(path.dirname(approvalStorePath), { recursive: true, force: true });
    const app = buildServer(testConfig({
      SECOPS_ACTION_LEVEL: "sandbox",
      SECOPS_SANDBOX_ROOT: sandboxRoot,
      SECOPS_APPROVAL_STORE_PATH: approvalStorePath
    }), { createModel: scriptedModelForRequest });

    const response = await app.inject({
      method: "POST",
      url: "/api/agent/run",
      payload: {
        messages: [
          {
            role: "user",
            content: "Write note for this invalid permission mode smoke test."
          }
        ],
        enabledTools: ["case.note.write"],
        permissionMode: "not-a-real-mode"
      }
    });

    expect(response.statusCode).toBe(200);
    const run = response.json();
    expect(run.status).toBe("needs_approval");
    expect(run.toolInvocations[0]?.status).toBe("pending_approval");
    expect(await caseFileCount(sandboxRoot, "INC-LOCAL-TEST")).toBe(0);

    const approvals = await app.inject({
      method: "GET",
      url: "/api/approvals"
    });
    expect(approvals.json().approvals).toHaveLength(1);

    await app.close();
    await rm(sandboxRoot, { recursive: true, force: true });
    await rm(path.dirname(approvalStorePath), { recursive: true, force: true });
  });

  it("returns an empty durable session list when postgres is not configured", async () => {
    const app = buildServer(testConfig({}));

    const sessions = await app.inject({
      method: "GET",
      url: "/api/sessions"
    });
    const missing = await app.inject({
      method: "GET",
      url: "/api/sessions/session-not-configured"
    });

    expect(sessions.statusCode).toBe(200);
    expect(sessions.json()).toEqual({ sessions: [] });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      error: "Durable session store is not configured"
    });

    await app.close();
  });
});

async function caseFileCount(sandboxRoot: string, caseId: string): Promise<number> {
  try {
    const files = await readdir(path.join(sandboxRoot, "cases", caseId));
    return files.length;
  } catch {
    return 0;
  }
}
