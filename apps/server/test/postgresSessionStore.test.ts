import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRun, AuditEvent, ChatMessage, EvidenceArtifact, ToolGuidance, ToolInvocation } from "@secops-agent/shared";
import { PostgresSessionStore } from "../src/runtime/postgresSessionStore.js";
import { createPostgresTestDatabase, type PostgresTestDatabase } from "./fixtures/postgres.js";

const maybeIt = process.env.SECOPS_TEST_DATABASE_URL?.trim() ? it : it.skip;
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

describe("PostgresSessionStore", () => {
  maybeIt("stores and restores durable agent session state after restart", async () => {
    database = await createPostgresTestDatabase();
    expect(database).toBeDefined();
    const firstStore = new PostgresSessionStore(database!.connectionString);
    stores.push(firstStore);
    await firstStore.migrate();

    const sessionId = "session-postgres-test";
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const message = chat("user", "Investigate workflow state.");
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
      id: "tool-call-1",
      toolName: "shuffle.workflow.execute",
      displayName: "Execute Shuffle Workflow",
      status: "failed",
      risk: "high",
      arguments: { workflowId: "wf-1" },
      result: {
        status: "needs_precondition",
        guidance
      },
      guidance,
      startedAt,
      completedAt: new Date().toISOString()
    };
    const artifact: EvidenceArtifact = {
      id: "artifact-1",
      title: "Workflow metadata",
      kind: "runtime",
      summary: "Workflow metadata marker.",
      data: { stateMarkers: ["shuffle.workflow.metadata:wf-1"] },
      createdAt: new Date().toISOString()
    };
    const audit: AuditEvent = {
      id: "audit-1",
      type: "tool_result",
      label: "Tool result",
      detail: "Recoverable guidance returned.",
      severity: "warn",
      createdAt: new Date().toISOString()
    };

    await firstStore.startRun({ sessionId, runId, startedAt });
    await firstStore.appendMessage(sessionId, runId, message);
    await firstStore.recordToolInvocation(sessionId, runId, invocation, [artifact]);
    await firstStore.recordGuidance(sessionId, runId, invocation.id, guidance);
    await firstStore.recordAuditEvent(sessionId, runId, audit);
    await firstStore.recordStateMarkers(sessionId, runId, [
      {
        key: "shuffle.workflow.metadata:wf-1",
        value: {
          workflowId: "wf-1",
          toolName: "shuffle.workflow.get"
        }
      }
    ]);
    const run: AgentRun = {
      id: runId,
      status: "completed",
      provider: "test-provider",
      model: "test-model",
      startedAt,
      completedAt: new Date().toISOString(),
      messages: [message],
      toolInvocations: [invocation],
      audit: [audit],
      artifacts: [artifact]
    };
    await firstStore.completeRun(sessionId, run);

    const secondStore = new PostgresSessionStore(database!.connectionString);
    stores.push(secondStore);
    const restored = await secondStore.restoreSession(sessionId);

    expect(restored).toBeDefined();
    expect(restored?.runs).toMatchObject([{ id: runId, status: "completed" }]);
    expect(restored?.messages).toEqual([message]);
    expect(restored?.toolInvocations).toEqual([invocation]);
    expect(restored?.guidance).toEqual([guidance]);
    expect(restored?.artifacts).toEqual([artifact]);
    expect(restored?.audit).toEqual([audit]);
    expect(restored?.stateMarkers).toMatchObject([
      {
        sessionId,
        runId,
        key: "shuffle.workflow.metadata:wf-1",
        value: {
          workflowId: "wf-1",
          toolName: "shuffle.workflow.get"
        }
      }
    ]);
  });

  maybeIt("rolls back partial tool invocation state when artifact persistence fails", async () => {
    database = await createPostgresTestDatabase();
    expect(database).toBeDefined();
    const store = new PostgresSessionStore(database!.connectionString);
    stores.push(store);
    await store.migrate();
    const sessionId = "session-postgres-rollback";
    const runId = randomUUID();
    await store.startRun({ sessionId, runId, startedAt: new Date().toISOString() });

    const invocation: ToolInvocation = {
      id: "tool-call-rollback",
      toolName: "case.note.write",
      displayName: "Write Case Note",
      status: "executed",
      risk: "medium",
      arguments: {},
      result: { ok: true },
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    };
    const invalidArtifact: EvidenceArtifact = {
      id: "artifact-invalid-time",
      title: "Invalid artifact",
      kind: "runtime",
      summary: "Invalid timestamp should force rollback.",
      data: {},
      createdAt: "not-a-date"
    };

    await expect(store.recordToolInvocation(sessionId, runId, invocation, [invalidArtifact])).rejects.toThrow();
    const rows = await store.pool.query(
      "SELECT id FROM secops_tool_invocations WHERE id = $1",
      [invocation.id]
    );
    expect(rows.rowCount).toBe(0);
  });

  it("skips real Postgres checks when SECOPS_TEST_DATABASE_URL is not configured", () => {
    if (process.env.SECOPS_TEST_DATABASE_URL?.trim()) {
      return;
    }
    expect(process.env.SECOPS_TEST_DATABASE_URL).toBeUndefined();
  });
});

function chat(role: ChatMessage["role"], content: string): ChatMessage {
  return {
    id: randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString()
  };
}
