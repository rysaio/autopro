import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRun, AuditEvent, ChatMessage, EvidenceArtifact, ToolGuidance, ToolInvocation } from "@secops-agent/shared";
import { PostgresSessionStore } from "../src/runtime/postgresSessionStore.js";

let stores: PostgresSessionStore[] = [];

afterEach(async () => {
  for (const store of stores) {
    await store.close();
  }
  stores = [];
});

// Simulate a process restart against embedded PGlite: dump the entire data dir
// to a snapshot, close the original instance, then rebuild a fresh instance
// from that snapshot. This exercises PGlite's real persistence round-trip
// without touching the filesystem (avoids Windows tmpdir file-lock flakiness).
async function restartViaSnapshot(first: PGlite): Promise<PostgresSessionStore> {
  const snapshot = await first.dumpDataDir();
  await first.close();
  return new PostgresSessionStore(new PGlite({ loadDataDir: snapshot }));
}

describe("PostgresSessionStore", () => {
  it("stores and restores durable agent session state after restart", async () => {
    const first = new PGlite();
    const firstStore = new PostgresSessionStore(first);
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

    const secondStore = await restartViaSnapshot(first);
    stores.push(secondStore);
    const sessions = await secondStore.listSessions();
    const restored = await secondStore.restoreSession(sessionId);

    expect(sessions).toMatchObject([
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
    expect(restored).toBeDefined();
    expect(restored).toMatchObject({
      id: sessionId,
      runCount: 1,
      messageCount: 1,
      toolInvocationCount: 1,
      guidanceCount: 1,
      pendingApprovalCount: 0,
      latestMessage: message
    });
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

  it("rolls back partial tool invocation state when artifact persistence fails", async () => {
    const store = new PostgresSessionStore(new PGlite());
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
    const rows = await store.db.query(
      "SELECT id FROM secops_tool_invocations WHERE id = $1",
      [invocation.id]
    );
    expect(rows.rows.length).toBe(0);
  });

  it("restores and consumes pending approvals from postgres", async () => {
    const first = new PGlite();
    const firstStore = new PostgresSessionStore(first);
    await firstStore.migrate();
    const pendingInvocation: ToolInvocation = {
      id: "tool-call-approval",
      toolName: "case.note.write",
      displayName: "Write Case Note",
      status: "pending_approval",
      risk: "medium",
      arguments: { caseId: "INC-PG-APPROVAL" },
      error: "Action tool requires explicit analyst approval",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    };

    await firstStore.add({
      apiName: "secops_case_note_write",
      args: { caseId: "INC-PG-APPROVAL" },
      context: {
        runId: "run-pg-approval",
        sessionId: "session-pg-approval",
        permissionMode: "ask",
        actionLevel: "sandbox",
        sandboxRoot: "runtime/postgres-approval",
        workspaceRoot: "."
      },
      invocation: pendingInvocation
    });

    const secondStore = await restartViaSnapshot(first);
    stores.push(secondStore);
    await expect(secondStore.list()).resolves.toMatchObject([
      {
        id: "tool-call-approval",
        runId: "run-pg-approval",
        apiName: "secops_case_note_write",
        arguments: { caseId: "INC-PG-APPROVAL" }
      }
    ]);
    const restored = await secondStore.take("tool-call-approval");
    expect(restored).toMatchObject({
      apiName: "secops_case_note_write",
      context: {
        runId: "run-pg-approval",
        sessionId: "session-pg-approval"
      },
      invocation: {
        id: "tool-call-approval",
        status: "pending_approval"
      }
    });
    await expect(secondStore.list()).resolves.toHaveLength(0);
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
