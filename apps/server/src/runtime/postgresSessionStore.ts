import { randomUUID } from "node:crypto";
import { Pool, type PoolConfig, type QueryResultRow } from "pg";
import type {
  AgentRun,
  AgentRunEvent,
  AuditEvent,
  ChatMessage,
  EvidenceArtifact,
  ToolGuidance,
  ToolInvocation
} from "@secops-agent/shared";
import { migratePostgresSessionStore, withTransaction } from "./postgresMigrations.js";
import type { SessionStateStore, StateMarker } from "./sessionStateStore.js";

export class PostgresSessionStore implements SessionStateStore {
  readonly pool: Pool;

  constructor(input: string | Pool | PoolConfig) {
    this.pool = input instanceof Pool
      ? input
      : new Pool(typeof input === "string" ? { connectionString: input } : input);
  }

  async migrate(): Promise<void> {
    await migratePostgresSessionStore(this.pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async startRun(input: { sessionId: string; runId: string; startedAt: string }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO secops_sessions (id, created_at, updated_at)
         VALUES ($1, $2, $2)
         ON CONFLICT (id) DO UPDATE SET updated_at = EXCLUDED.updated_at`,
        [input.sessionId, input.startedAt]
      );
      await client.query(
        `INSERT INTO secops_runs (id, session_id, started_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO NOTHING`,
        [input.runId, input.sessionId, input.startedAt]
      );
    });
  }

  async appendMessage(sessionId: string, runId: string, message: ChatMessage): Promise<void> {
    await this.pool.query(
      `INSERT INTO secops_messages (id, session_id, run_id, message, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (id) DO NOTHING`,
      [message.id, sessionId, runId, JSON.stringify(message), message.createdAt]
    );
  }

  async recordToolInvocation(
    sessionId: string,
    runId: string,
    invocation: ToolInvocation,
    artifacts: EvidenceArtifact[]
  ): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO secops_tool_invocations (id, session_id, run_id, invocation)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (id) DO UPDATE SET invocation = EXCLUDED.invocation`,
        [invocation.id, sessionId, runId, JSON.stringify(invocation)]
      );
      for (const artifact of artifacts) {
        await client.query(
          `INSERT INTO secops_artifacts (id, session_id, run_id, tool_call_id, artifact, created_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)
           ON CONFLICT (id) DO UPDATE SET artifact = EXCLUDED.artifact`,
          [artifact.id, sessionId, runId, invocation.id, JSON.stringify(artifact), artifact.createdAt]
        );
      }
    });
  }

  async recordGuidance(sessionId: string, runId: string, toolCallId: string, guidance: ToolGuidance): Promise<void> {
    await this.pool.query(
      `INSERT INTO secops_tool_guidance (id, session_id, run_id, tool_call_id, guidance)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [randomUUID(), sessionId, runId, toolCallId, JSON.stringify(guidance)]
    );
  }

  async recordAuditEvent(sessionId: string, runId: string, audit: AuditEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO secops_audit_events (id, session_id, run_id, audit, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (id) DO NOTHING`,
      [audit.id, sessionId, runId, JSON.stringify(audit), audit.createdAt]
    );
  }

  async recordRunEvent(event: AgentRunEvent): Promise<void> {
    await this.pool.query(
      `UPDATE secops_runs
       SET run = COALESCE(run, '{}'::jsonb) || jsonb_build_object('lastEvent', $2::jsonb)
       WHERE id = $1`,
      [event.runId, JSON.stringify(event)]
    );
  }

  async recordStateMarkers(
    sessionId: string,
    runId: string,
    markers: Array<Omit<StateMarker, "id" | "sessionId" | "runId" | "createdAt">>
  ): Promise<void> {
    for (const marker of markers) {
      await this.pool.query(
        `INSERT INTO secops_state_markers (id, session_id, run_id, key, value)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [randomUUID(), sessionId, runId, marker.key, JSON.stringify(marker.value)]
      );
    }
  }

  async listStateMarkers(sessionId: string): Promise<StateMarker[]> {
    const result = await this.pool.query<StateMarkerRow>(
      `SELECT id, session_id, run_id, key, value, created_at
       FROM secops_state_markers
       WHERE session_id = $1
       ORDER BY created_at ASC, id ASC`,
      [sessionId]
    );
    return result.rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      runId: row.run_id,
      key: row.key,
      value: row.value,
      createdAt: toIso(row.created_at)
    }));
  }

  async completeRun(sessionId: string, run: AgentRun): Promise<void> {
    await this.pool.query(
      `UPDATE secops_runs
       SET status = $3,
           provider = $4,
           model = $5,
           completed_at = $6,
           run = $7::jsonb
       WHERE id = $1 AND session_id = $2`,
      [run.id, sessionId, run.status, run.provider, run.model, run.completedAt, JSON.stringify(run)]
    );
    await this.pool.query(
      `UPDATE secops_sessions SET updated_at = $2 WHERE id = $1`,
      [sessionId, run.completedAt]
    );
  }

  async restoreSession(sessionId: string): Promise<RestoredSession | undefined> {
    const session = await this.pool.query<SessionRow>(
      `SELECT id, created_at, updated_at FROM secops_sessions WHERE id = $1`,
      [sessionId]
    );
    const sessionRow = session.rows[0];
    if (!sessionRow) {
      return undefined;
    }
    const runs = await this.pool.query<RunRow>(
      `SELECT id, run FROM secops_runs WHERE session_id = $1 ORDER BY started_at ASC`,
      [sessionId]
    );
    const messages = await this.pool.query<JsonPayloadRow<"message">>(
      `SELECT message FROM secops_messages WHERE session_id = $1 ORDER BY created_at ASC`,
      [sessionId]
    );
    const invocations = await this.pool.query<JsonPayloadRow<"invocation">>(
      `SELECT invocation FROM secops_tool_invocations WHERE session_id = $1 ORDER BY created_at ASC`,
      [sessionId]
    );
    const artifacts = await this.pool.query<JsonPayloadRow<"artifact">>(
      `SELECT artifact FROM secops_artifacts WHERE session_id = $1 ORDER BY created_at ASC`,
      [sessionId]
    );
    const guidance = await this.pool.query<JsonPayloadRow<"guidance">>(
      `SELECT guidance FROM secops_tool_guidance WHERE session_id = $1 ORDER BY created_at ASC`,
      [sessionId]
    );
    const audit = await this.pool.query<JsonPayloadRow<"audit">>(
      `SELECT audit FROM secops_audit_events WHERE session_id = $1 ORDER BY created_at ASC`,
      [sessionId]
    );
    return {
      id: sessionRow.id,
      createdAt: toIso(sessionRow.created_at),
      updatedAt: toIso(sessionRow.updated_at),
      runs: runs.rows.map((row) => row.run).filter((run): run is AgentRun => Boolean(run)),
      messages: messages.rows.map((row) => row.message as ChatMessage),
      toolInvocations: invocations.rows.map((row) => row.invocation as ToolInvocation),
      artifacts: artifacts.rows.map((row) => row.artifact as EvidenceArtifact),
      guidance: guidance.rows.map((row) => row.guidance as ToolGuidance),
      audit: audit.rows.map((row) => row.audit as AuditEvent),
      stateMarkers: await this.listStateMarkers(sessionId)
    };
  }
}

export interface RestoredSession {
  id: string;
  createdAt: string;
  updatedAt: string;
  runs: AgentRun[];
  messages: ChatMessage[];
  toolInvocations: ToolInvocation[];
  artifacts: EvidenceArtifact[];
  guidance: ToolGuidance[];
  audit: AuditEvent[];
  stateMarkers: StateMarker[];
}

interface SessionRow extends QueryResultRow {
  id: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RunRow extends QueryResultRow {
  id: string;
  run: AgentRun | null;
}

interface StateMarkerRow extends QueryResultRow {
  id: string;
  session_id: string;
  run_id: string;
  key: string;
  value: unknown;
  created_at: Date | string;
}

type JsonPayloadRow<Key extends string> = QueryResultRow & Record<Key, unknown>;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
