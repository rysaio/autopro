import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/app.js";
import { scriptedModelForRequest, testConfig } from "./fixtures/testConfig.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createPostgresTestDatabase } from "./fixtures/postgres.js";

const maybePostgresIt = process.env.SECOPS_TEST_DATABASE_URL?.trim() ? it : it.skip;

describe("approval flow", () => {
  it("keeps ask-mode action calls pending until explicitly approved", async () => {
    const sandboxRoot = path.resolve("runtime/approval-allow-sandbox");
    const auditLogPath = path.resolve("runtime/approval-allow-audit/events.jsonl");
    const approvalStorePath = path.resolve("runtime/approval-allow-store/pending.json");
    await rm(sandboxRoot, { recursive: true, force: true });
    await rm(path.dirname(auditLogPath), { recursive: true, force: true });
    await rm(path.dirname(approvalStorePath), { recursive: true, force: true });
    const app = buildServer(testConfig({
      SECOPS_ACTION_LEVEL: "sandbox",
      SECOPS_SANDBOX_ROOT: sandboxRoot,
      SECOPS_AUDIT_LOG_PATH: auditLogPath,
      SECOPS_APPROVAL_STORE_PATH: approvalStorePath
    }));

    const pendingResponse = await app.inject({
      method: "POST",
      url: "/api/mcp/tools/secops_case_note_write/call",
      payload: {
        permissionMode: "ask",
        args: {
          caseId: "INC-APPROVE-1",
          title: "Approval write smoke",
          body: "This note should appear only after approval."
        }
      }
    });

    expect(pendingResponse.statusCode).toBe(200);
    const pending = pendingResponse.json();
    expect(pending.invocation.status).toBe("pending_approval");
    expect(await caseFileCount(sandboxRoot, "INC-APPROVE-1")).toBe(0);

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/approvals"
    });
    expect(listResponse.json().approvals).toHaveLength(1);

    const approvalResponse = await app.inject({
      method: "POST",
      url: `/api/approvals/${pending.invocation.id}/approve`
    });

    expect(approvalResponse.statusCode).toBe(200);
    const approved = approvalResponse.json();
    expect(approved.decision).toBe("approved");
    expect(approved.runId).toBeTruthy();
    expect(approved.invocation.status).toBe("executed");
    expect(approved.audit.map((entry: { type: string }) => entry.type)).toContain("policy_decision");
    expect(approved.messages.map((message: { role: string }) => message.role)).toEqual(["tool", "assistant"]);
    expect(await caseFileCount(sandboxRoot, "INC-APPROVE-1")).toBe(1);

    const auditResponse = await app.inject({
      method: "GET",
      url: "/api/audit/events"
    });
    const persisted = auditResponse.json().events;
    expect(JSON.stringify(persisted)).toContain("Approval allowed");
    expect(JSON.stringify(persisted)).toContain(approved.invocation.id);

    const staleResponse = await app.inject({
      method: "POST",
      url: `/api/approvals/${pending.invocation.id}/approve`
    });
    expect(staleResponse.statusCode).toBe(404);

    await app.close();
    await rm(sandboxRoot, { recursive: true, force: true });
    await rm(path.dirname(auditLogPath), { recursive: true, force: true });
    await rm(path.dirname(approvalStorePath), { recursive: true, force: true });
  });

  it("denies pending action calls without side effects", async () => {
    const sandboxRoot = path.resolve("runtime/approval-deny-sandbox");
    const approvalStorePath = path.resolve("runtime/approval-deny-store/pending.json");
    await rm(sandboxRoot, { recursive: true, force: true });
    await rm(path.dirname(approvalStorePath), { recursive: true, force: true });
    const app = buildServer(testConfig({
      SECOPS_ACTION_LEVEL: "sandbox",
      SECOPS_SANDBOX_ROOT: sandboxRoot,
      SECOPS_APPROVAL_STORE_PATH: approvalStorePath
    }), { createModel: scriptedModelForRequest });

    const pendingResponse = await app.inject({
      method: "POST",
      url: "/api/mcp/tools/secops_case_note_write/call",
      payload: {
        permissionMode: "ask",
        args: {
          caseId: "INC-DENY-1",
          title: "Denied write smoke",
          body: "This note should never be written."
        }
      }
    });

    const pending = pendingResponse.json();
    const denyResponse = await app.inject({
      method: "POST",
      url: `/api/approvals/${pending.invocation.id}/deny`
    });

    expect(denyResponse.statusCode).toBe(200);
    const denied = denyResponse.json();
    expect(denied.decision).toBe("denied");
    expect(denied.invocation.status).toBe("denied");
    expect(await caseFileCount(sandboxRoot, "INC-DENY-1")).toBe(0);

    await app.close();
    await rm(sandboxRoot, { recursive: true, force: true });
    await rm(path.dirname(approvalStorePath), { recursive: true, force: true });
  });

  it("ignores client-supplied approved tool call ids on agent runs", async () => {
    const sandboxRoot = path.resolve("runtime/approval-client-replay-sandbox");
    const approvalStorePath = path.resolve("runtime/approval-client-replay-store/pending.json");
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
            content: "Write note for this case note smoke test."
          }
        ],
        enabledTools: ["case.note.write"],
        permissionMode: "ask",
        approvedToolCallIds: ["client-supplied-id"]
      }
    });

    expect(response.statusCode).toBe(200);
    const run = response.json();
    expect(run.status).toBe("needs_approval");
    expect(run.toolInvocations[0]?.status).toBe("pending_approval");
    expect(await caseFileCount(sandboxRoot, "INC-LOCAL-TEST")).toBe(0);

    await app.close();
    await rm(sandboxRoot, { recursive: true, force: true });
    await rm(path.dirname(approvalStorePath), { recursive: true, force: true });
  });

  it("persists pending approvals across server restarts", async () => {
    const sandboxRoot = path.resolve("runtime/approval-persist-sandbox");
    const approvalStorePath = path.resolve("runtime/approval-persist-store/pending.json");
    await rm(sandboxRoot, { recursive: true, force: true });
    await rm(path.dirname(approvalStorePath), { recursive: true, force: true });

    const firstApp = buildServer(testConfig({
      SECOPS_ACTION_LEVEL: "sandbox",
      SECOPS_SANDBOX_ROOT: sandboxRoot,
      SECOPS_APPROVAL_STORE_PATH: approvalStorePath
    }));

    const pendingResponse = await firstApp.inject({
      method: "POST",
      url: "/api/mcp/tools/secops_case_note_write/call",
      payload: {
        permissionMode: "ask",
        args: {
          caseId: "INC-PERSIST-1",
          title: "Persisted approval",
          body: "This note should survive a server restart before approval."
        }
      }
    });
    const pending = pendingResponse.json();
    expect(pending.invocation.status).toBe("pending_approval");
    await firstApp.close();

    const persistedStore = await readFile(approvalStorePath, "utf8");
    expect(persistedStore).toContain("INC-PERSIST-1");
    expect(persistedStore).toContain("expiresAt");
    expect(persistedStore).not.toContain("context");
    expect(persistedStore).not.toContain("actionLevel");
    expect(persistedStore).not.toContain("sandboxRoot");
    expect(persistedStore).not.toContain("workspaceRoot");
    expect(persistedStore).not.toContain("result");

    const secondApp = buildServer(testConfig({
      SECOPS_ACTION_LEVEL: "sandbox",
      SECOPS_SANDBOX_ROOT: sandboxRoot,
      SECOPS_APPROVAL_STORE_PATH: approvalStorePath
    }));

    const listResponse = await secondApp.inject({
      method: "GET",
      url: "/api/approvals"
    });
    expect(listResponse.json().approvals).toHaveLength(1);

    const approvalResponse = await secondApp.inject({
      method: "POST",
      url: `/api/approvals/${pending.invocation.id}/approve`
    });
    const approved = approvalResponse.json();
    expect(approved.invocation.status).toBe("executed");
    expect(await caseFileCount(sandboxRoot, "INC-PERSIST-1")).toBe(1);

    const afterApproval = await secondApp.inject({
      method: "GET",
      url: "/api/approvals"
    });
    expect(afterApproval.json().approvals).toHaveLength(0);

    await secondApp.close();
    await rm(sandboxRoot, { recursive: true, force: true });
    await rm(path.dirname(approvalStorePath), { recursive: true, force: true });
  });

  maybePostgresIt("persists pending approvals across app restarts through postgres", async () => {
    const database = await createPostgresTestDatabase();
    expect(database).toBeDefined();
    const sandboxRoot = path.resolve("runtime/approval-postgres-sandbox");
    let firstApp: ReturnType<typeof buildServer> | undefined;
    let secondApp: ReturnType<typeof buildServer> | undefined;
    await rm(sandboxRoot, { recursive: true, force: true });

    try {
      firstApp = buildServer(testConfig({
        SECOPS_ACTION_LEVEL: "sandbox",
        SECOPS_SANDBOX_ROOT: sandboxRoot,
        SECOPS_DATABASE_URL: database!.connectionString
      }));

      const pendingResponse = await firstApp.inject({
        method: "POST",
        url: "/api/mcp/tools/secops_case_note_write/call",
        payload: {
          permissionMode: "ask",
          args: {
            caseId: "INC-POSTGRES-APPROVAL",
            title: "Postgres persisted approval",
            body: "This note should survive an app restart in postgres."
          }
        }
      });
      const pending = pendingResponse.json();
      expect(pending.invocation.status).toBe("pending_approval");
      await firstApp.close();
      firstApp = undefined;

      secondApp = buildServer(testConfig({
        SECOPS_ACTION_LEVEL: "sandbox",
        SECOPS_SANDBOX_ROOT: sandboxRoot,
        SECOPS_DATABASE_URL: database!.connectionString
      }));
      const listResponse = await secondApp.inject({
        method: "GET",
        url: "/api/approvals"
      });
      expect(listResponse.json().approvals).toMatchObject([
        {
          id: pending.invocation.id,
          apiName: "secops_case_note_write",
          arguments: {
            caseId: "INC-POSTGRES-APPROVAL"
          }
        }
      ]);

      const approvalResponse = await secondApp.inject({
        method: "POST",
        url: `/api/approvals/${pending.invocation.id}/approve`
      });
      expect(approvalResponse.statusCode).toBe(200);
      expect(approvalResponse.json().invocation.status).toBe("executed");
      expect(await caseFileCount(sandboxRoot, "INC-POSTGRES-APPROVAL")).toBe(1);
      await expect(secondApp.inject({
        method: "GET",
        url: "/api/approvals"
      }).then((response) => response.json().approvals)).resolves.toHaveLength(0);
      await secondApp.close();
      secondApp = undefined;
    } finally {
      await firstApp?.close();
      await secondApp?.close();
      await database?.cleanup();
      await rm(sandboxRoot, { recursive: true, force: true });
    }
  });

  it("executes full-access tools immediately in full-access mode", async () => {
    const sandboxRoot = path.resolve("runtime/approval-policy-full-access-sandbox");
    const approvalStorePath = path.resolve("runtime/approval-policy-full-access-store/pending.json");
    await rm(sandboxRoot, { recursive: true, force: true });
    await rm(path.dirname(approvalStorePath), { recursive: true, force: true });

    const fullAccessApp = buildServer(testConfig({
      SECOPS_ACTION_LEVEL: "full-access",
      SECOPS_SANDBOX_ROOT: sandboxRoot,
      SECOPS_APPROVAL_STORE_PATH: approvalStorePath
    }));

    const executedResponse = await fullAccessApp.inject({
      method: "POST",
      url: "/api/mcp/tools/secops_full_access_exec/call",
      payload: {
        permissionMode: "auto",
        args: {
          command: "node",
          args: ["--version"]
        }
      }
    });
    const executed = executedResponse.json();
    expect(executed.invocation.status).toBe("executed");
    expect(executed.invocation.result.stdout).toContain("v");
    await expect(fullAccessApp.inject({
      method: "GET",
      url: "/api/approvals"
    }).then((response) => response.json().approvals)).resolves.toHaveLength(0);
    await fullAccessApp.close();
    await rm(sandboxRoot, { recursive: true, force: true });
    await rm(path.dirname(approvalStorePath), { recursive: true, force: true });
  });

  it("drops persisted approvals with invalid expiry metadata", async () => {
    const approvalStorePath = path.resolve("runtime/approval-invalid-expiry-store/pending.json");
    await rm(path.dirname(approvalStorePath), { recursive: true, force: true });
    await mkdir(path.dirname(approvalStorePath), { recursive: true });
    await writeFile(approvalStorePath, JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      approvals: [
        {
          id: "invalid-expiry",
          runId: "run-invalid-expiry",
          apiName: "secops_case_note_write",
          toolName: "case.note.write",
          displayName: "Write Case Note",
          risk: "medium",
          args: {
            caseId: "INC-INVALID-EXPIRY",
            title: "Invalid expiry",
            body: "This should not be restorable."
          },
          requestedAt: new Date().toISOString(),
          expiresAt: "not-a-date"
        }
      ]
    }), "utf8");

    const app = buildServer(testConfig({
      SECOPS_APPROVAL_STORE_PATH: approvalStorePath
    }));

    const response = await app.inject({
      method: "GET",
      url: "/api/approvals"
    });
    expect(response.json().approvals).toHaveLength(0);

    await app.close();
    await rm(path.dirname(approvalStorePath), { recursive: true, force: true });
  });

  it("allows read-only tools but denies action tools at observe action level", async () => {
    const sandboxRoot = path.resolve("runtime/approval-observe-sandbox");
    await rm(sandboxRoot, { recursive: true, force: true });
    const registry = new ToolRegistry();
    const context = {
      runId: "observe-test",
      permissionMode: "auto" as const,
      actionLevel: "observe" as const,
      sandboxRoot,
      workspaceRoot: path.resolve(".")
    };

    const readOnly = await registry.executeApiTool(
      "secops_ioc_enrich",
      "read-only-call",
      { indicator: "198.51.100.23" },
      context
    );
    expect(readOnly.invocation.status).toBe("executed");
    expect(readOnly.artifacts[0]?.kind).toBe("ioc");

    const action = await registry.executeApiTool(
      "secops_case_note_write",
      "action-call",
      {
        caseId: "INC-OBSERVE-1",
        title: "Observe write smoke",
        body: "This note should not be written."
      },
      context
    );
    expect(action.invocation.status).toBe("denied");
    expect(await caseFileCount(sandboxRoot, "INC-OBSERVE-1")).toBe(0);
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  it("full-access mode overrides deny permission mode for action tools", async () => {
    const sandboxRoot = path.resolve("runtime/approval-full-access-sandbox");
    const approvalStorePath = path.resolve("runtime/approval-full-access-store/pending.json");
    await rm(sandboxRoot, { recursive: true, force: true });
    await rm(path.dirname(approvalStorePath), { recursive: true, force: true });
    const app = buildServer(testConfig({
      SECOPS_ACTION_LEVEL: "full-access",
      SECOPS_SANDBOX_ROOT: sandboxRoot,
      SECOPS_APPROVAL_STORE_PATH: approvalStorePath
    }));

    const executedResponse = await app.inject({
      method: "POST",
      url: "/api/mcp/tools/secops_full_access_exec/call",
      payload: {
        permissionMode: "deny",
        args: {
          command: "node",
          args: ["--version"]
        }
      }
    });

    expect(executedResponse.statusCode).toBe(200);
    const executed = executedResponse.json();
    expect(executed.invocation.status).toBe("executed");
    expect(executed.invocation.result.stdout).toContain("v");

    await app.close();
    await rm(sandboxRoot, { recursive: true, force: true });
    await rm(path.dirname(approvalStorePath), { recursive: true, force: true });
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
