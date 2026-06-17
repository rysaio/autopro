import type {
  ApprovalDecisionResult,
  AuditEvent,
  ChatMessage,
  PendingApproval,
  ToolInvocation
} from "@secops-agent/shared";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ToolContext, ToolExecutionRecord } from "../tools/types.js";

export interface StoredApproval {
  apiName: string;
  args: Record<string, unknown>;
  context: ToolContext;
  invocation: ToolInvocation;
  expiresAt?: string;
}

interface ApprovalStoreSnapshot {
  version: 1;
  updatedAt: string;
  approvals: StoredPendingApprovalV1[];
}

interface StoredPendingApprovalV1 {
  id: string;
  runId: string;
  apiName: string;
  toolName: string;
  displayName: string;
  risk: ToolInvocation["risk"];
  args: Record<string, unknown>;
  requestedAt: string;
  expiresAt: string;
}

const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export class ApprovalStore {
  private readonly pending = new Map<string, StoredApproval>();

  constructor(private readonly filePath?: string) {
    this.load();
  }

  add(record: StoredApproval): PendingApproval {
    const normalized = normalizeStoredApproval(record);
    this.pending.set(normalized.invocation.id, cloneStoredApproval(normalized));
    this.persist();
    return toPendingApproval(normalized);
  }

  list(): PendingApproval[] {
    this.pruneExpired();
    return [...this.pending.values()].map(toPendingApproval);
  }

  get(id: string): StoredApproval | undefined {
    this.pruneExpired();
    const record = this.pending.get(id);
    return record ? cloneStoredApproval(record) : undefined;
  }

  take(id: string): StoredApproval | undefined {
    const record = this.get(id);
    if (record) {
      this.pending.delete(id);
      this.persist();
    }
    return record;
  }

  deny(id: string): ApprovalDecisionResult | undefined {
    const record = this.take(id);
    if (!record) {
      return undefined;
    }
    const deniedInvocation: ToolInvocation = {
      ...record.invocation,
      status: "denied",
      error: "Tool execution denied by analyst approval decision",
      completedAt: new Date().toISOString()
    };
    return {
      decision: "denied",
      runId: record.context.runId,
      invocation: deniedInvocation,
      artifacts: [],
      audit: approvalAudit(record.context.runId, deniedInvocation, "denied"),
      messages: approvalMessages(deniedInvocation, "denied")
    };
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) {
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
      const snapshot = parseSnapshot(parsed);
      if (!snapshot) {
        return;
      }
      for (const approval of snapshot.approvals) {
        const restored = restoreStoredApproval(approval);
        if (restored && !isExpired(restored)) {
          this.pending.set(restored.invocation.id, restored);
        }
      }
    } catch {
      this.pending.clear();
    }
  }

  private persist(): void {
    if (!this.filePath) {
      return;
    }
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const snapshot: ApprovalStoreSnapshot = {
      version: 1,
      updatedAt: new Date().toISOString(),
      approvals: [...this.pending.values()].map(toPersistedApproval)
    };
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, this.filePath);
  }

  private pruneExpired(): void {
    let changed = false;
    for (const [id, record] of this.pending.entries()) {
      if (isExpired(record)) {
        this.pending.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
  }
}

export function approvalResult(record: ToolExecutionRecord, runId: string): ApprovalDecisionResult {
  return {
    decision: "approved",
    runId,
    invocation: record.invocation,
    artifacts: record.artifacts,
    audit: approvalAudit(runId, record.invocation, "approved"),
    messages: approvalMessages(record.invocation, "approved")
  };
}

function toPendingApproval(record: StoredApproval): PendingApproval {
  return {
    id: record.invocation.id,
    runId: record.context.runId,
    toolName: record.invocation.toolName,
    apiName: record.apiName,
    displayName: record.invocation.displayName,
    risk: record.invocation.risk,
    arguments: structuredClone(record.args),
    requestedAt: record.invocation.startedAt,
    expiresAt: record.expiresAt ?? expiresAtFor(record.invocation.startedAt)
  };
}

function cloneStoredApproval(record: StoredApproval): StoredApproval {
  const context: ToolContext = { ...record.context };
  if (record.context.approvedToolCallIds) {
    context.approvedToolCallIds = [...record.context.approvedToolCallIds];
  }
  const invocation: ToolInvocation = {
    ...record.invocation,
    arguments: structuredClone(record.invocation.arguments)
  };
  if ("result" in record.invocation) {
    invocation.result = structuredClone(record.invocation.result);
  }
  if (record.invocation.error) {
    invocation.error = record.invocation.error;
  }
  return {
    apiName: record.apiName,
    args: structuredClone(record.args),
    context,
    invocation,
    expiresAt: record.expiresAt ?? expiresAtFor(record.invocation.startedAt)
  };
}

function parseSnapshot(value: unknown): ApprovalStoreSnapshot | undefined {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.approvals)) {
    return undefined;
  }
  const approvals = value.approvals
    .map(parsePersistedApproval)
    .filter((approval): approval is StoredPendingApprovalV1 => Boolean(approval));
  return {
    version: 1,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
    approvals
  };
}

function parsePersistedApproval(value: unknown): StoredPendingApprovalV1 | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (
    typeof value.id !== "string" ||
    typeof value.runId !== "string" ||
    typeof value.apiName !== "string" ||
    typeof value.toolName !== "string" ||
    typeof value.displayName !== "string" ||
    typeof value.requestedAt !== "string" ||
    typeof value.expiresAt !== "string" ||
    !isRecord(value.args)
  ) {
    return undefined;
  }
  if (!["low", "medium", "high"].includes(String(value.risk))) {
    return undefined;
  }
  if (!Number.isFinite(Date.parse(value.expiresAt))) {
    return undefined;
  }
  return {
    id: value.id,
    runId: value.runId,
    apiName: value.apiName,
    toolName: value.toolName,
    displayName: value.displayName,
    risk: value.risk as ToolInvocation["risk"],
    args: structuredClone(value.args),
    requestedAt: value.requestedAt,
    expiresAt: value.expiresAt
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeStoredApproval(record: StoredApproval): StoredApproval {
  const cloned = cloneStoredApproval({
    ...record,
    expiresAt: record.expiresAt ?? expiresAtFor(record.invocation.startedAt)
  });
  cloned.invocation.status = "pending_approval";
  delete cloned.invocation.result;
  return cloned;
}

function toPersistedApproval(record: StoredApproval): StoredPendingApprovalV1 {
  return {
    id: record.invocation.id,
    runId: record.context.runId,
    apiName: record.apiName,
    toolName: record.invocation.toolName,
    displayName: record.invocation.displayName,
    risk: record.invocation.risk,
    args: structuredClone(record.args),
    requestedAt: record.invocation.startedAt,
    expiresAt: record.expiresAt ?? expiresAtFor(record.invocation.startedAt)
  };
}

function restoreStoredApproval(record: StoredPendingApprovalV1): StoredApproval | undefined {
  const restored: StoredApproval = {
    apiName: record.apiName,
    args: structuredClone(record.args),
    context: {
      runId: record.runId,
      permissionMode: "ask",
      actionLevel: "observe",
      sandboxRoot: "",
      workspaceRoot: ""
    },
    invocation: {
      id: record.id,
      toolName: record.toolName,
      displayName: record.displayName,
      status: "pending_approval",
      risk: record.risk,
      arguments: structuredClone(record.args),
      startedAt: record.requestedAt,
      completedAt: record.requestedAt,
      error: "Action tool requires explicit analyst approval"
    },
    expiresAt: record.expiresAt
  };
  return isExpired(restored) ? undefined : restored;
}

function expiresAtFor(startedAt: string): string {
  const started = Date.parse(startedAt);
  const base = Number.isFinite(started) ? started : Date.now();
  return new Date(base + DEFAULT_APPROVAL_TTL_MS).toISOString();
}

function isExpired(record: StoredApproval): boolean {
  if (!record.expiresAt) {
    return true;
  }
  const expires = Date.parse(record.expiresAt);
  return !Number.isFinite(expires) || expires <= Date.now();
}

function approvalAudit(
  runId: string,
  invocation: ToolInvocation,
  decision: ApprovalDecisionResult["decision"]
): AuditEvent[] {
  const severity = invocation.status === "failed" || decision === "denied" ? "warn" : "info";
  return [
    {
      id: crypto.randomUUID(),
      type: "policy_decision",
      label: decision === "approved" ? "Approval allowed" : "Approval denied",
      detail: `${invocation.displayName} ${decision} for run ${runId}.`,
      severity,
      createdAt: new Date().toISOString()
    },
    {
      id: crypto.randomUUID(),
      type: "tool_result",
      label: "Approval result",
      detail: `${invocation.displayName} ${invocation.status} after analyst decision.`,
      severity,
      createdAt: new Date().toISOString()
    }
  ];
}

function approvalMessages(
  invocation: ToolInvocation,
  decision: ApprovalDecisionResult["decision"]
): ChatMessage[] {
  const now = new Date().toISOString();
  return [
    {
      id: crypto.randomUUID(),
      role: "tool",
      content: JSON.stringify(invocation.result ?? invocation.error ?? { status: invocation.status }),
      createdAt: now,
      name: invocation.displayName,
      toolCallId: invocation.id
    },
    {
      id: crypto.randomUUID(),
      role: "assistant",
      content: decision === "approved"
        ? `Approval allowed. ${invocation.displayName} finished with status ${invocation.status}.`
        : `Approval denied. ${invocation.displayName} was not executed.`,
      createdAt: now
    }
  ];
}
