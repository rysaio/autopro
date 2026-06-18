import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { AuditEvent, ChatMessage, ToolGuidance, ToolInvocation } from "@secops-agent/shared";
import { buildServer } from "../src/app.js";
import { PostgresSessionStore } from "../src/runtime/postgresSessionStore.js";
import { createPostgresTestDatabase, type PostgresTestDatabase } from "./fixtures/postgres.js";
import { scriptedModelForRequest, testConfig } from "./fixtures/testConfig.js";

const maybePostgresIt = process.env.SECOPS_TEST_DATABASE_URL?.trim() ? it : it.skip;
let database: PostgresTestDatabase | undefined;
let stores: PostgresSessionStore[] = [];

afterEach(async () => {
  for (const store of stores) {
    await store.close();
  }
  stores = [];
  await database?.cleanup();
  database = undefined;
});

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

  maybePostgresIt("exposes durable sessions with guidance through the API", async () => {
    database = await createPostgresTestDatabase();
    expect(database).toBeDefined();
    const seedStore = new PostgresSessionStore(database!.connectionString);
    stores.push(seedStore);
    await seedStore.migrate();
    const sessionId = "session-api-guidance";
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const message: ChatMessage = {
      id: "message-api-guidance",
      role: "user",
      content: "Run Shuffle workflow wf-1.",
      createdAt: startedAt
    };
    const guidance: ToolGuidance = {
      kind: "precondition",
      message: "Call shuffle.workflow.get before shuffle.workflow.execute.",
      nextTools: [
        {
          toolName: "shuffle.workflow.get",
          reason: "Fetch workflow metadata before execution.",
          suggestedArgs: { workflowId: "wf-1" }
        }
      ],
      requiredState: ["shuffle.workflow.metadata:wf-1"],
      recoverable: true
    };
    const invocation: ToolInvocation = {
      id: "tool-api-guidance",
      toolName: "shuffle.workflow.execute",
      displayName: "Execute Shuffle Workflow",
      status: "failed",
      risk: "high",
      arguments: { workflowId: "wf-1" },
      result: { status: "needs_precondition", guidance },
      guidance,
      startedAt,
      completedAt: new Date().toISOString()
    };
    const audit: AuditEvent = {
      id: "audit-api-guidance",
      type: "tool_result",
      label: "Tool guidance",
      detail: "Recoverable tool guidance returned.",
      createdAt: new Date().toISOString(),
      severity: "warn"
    };
    await seedStore.startRun({ sessionId, runId, startedAt });
    await seedStore.appendMessage(sessionId, runId, message);
    await seedStore.recordToolInvocation(sessionId, runId, invocation, []);
    await seedStore.recordGuidance(sessionId, runId, invocation.id, guidance);
    await seedStore.recordAuditEvent(sessionId, runId, audit);
    await seedStore.completeRun(sessionId, {
      id: runId,
      status: "completed",
      provider: "test-provider",
      model: "test-model",
      startedAt,
      completedAt: new Date().toISOString(),
      messages: [message],
      toolInvocations: [invocation],
      audit: [audit],
      artifacts: []
    });

    const app = buildServer(testConfig({
      SECOPS_DATABASE_URL: database!.connectionString
    }));

    const list = await app.inject({
      method: "GET",
      url: "/api/sessions"
    });
    const detail = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}`
    });

    expect(list.statusCode).toBe(200);
    expect(list.json().sessions).toMatchObject([
      {
        id: sessionId,
        runCount: 1,
        messageCount: 1,
        toolInvocationCount: 1,
        guidanceCount: 1,
        pendingApprovalCount: 0,
        latestMessage: message
      }
    ]);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id: sessionId,
      guidance: [guidance],
      toolInvocations: [
        {
          id: invocation.id,
          guidance
        }
      ],
      audit: [audit]
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
