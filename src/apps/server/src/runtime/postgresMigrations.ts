import { PGlite } from "@electric-sql/pglite";
import type { Transaction } from "@electric-sql/pglite";

export async function migratePostgresSessionStore(db: PGlite): Promise<void> {
  // Multi-statement DDL must use exec() (Simple Query protocol). query() runs a
  // single statement via the Extended Query protocol and would reject this block.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS secops_sessions (
      id text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS secops_runs (
      id text PRIMARY KEY,
      session_id text NOT NULL REFERENCES secops_sessions(id) ON DELETE CASCADE,
      status text,
      provider text,
      model text,
      started_at timestamptz NOT NULL,
      completed_at timestamptz,
      run jsonb
    );

    CREATE TABLE IF NOT EXISTS secops_messages (
      id text PRIMARY KEY,
      session_id text NOT NULL REFERENCES secops_sessions(id) ON DELETE CASCADE,
      run_id text NOT NULL REFERENCES secops_runs(id) ON DELETE CASCADE,
      message jsonb NOT NULL,
      created_at timestamptz NOT NULL
    );

    CREATE TABLE IF NOT EXISTS secops_tool_invocations (
      id text PRIMARY KEY,
      session_id text NOT NULL REFERENCES secops_sessions(id) ON DELETE CASCADE,
      run_id text NOT NULL REFERENCES secops_runs(id) ON DELETE CASCADE,
      invocation jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS secops_tool_guidance (
      id text PRIMARY KEY,
      session_id text NOT NULL REFERENCES secops_sessions(id) ON DELETE CASCADE,
      run_id text NOT NULL REFERENCES secops_runs(id) ON DELETE CASCADE,
      tool_call_id text NOT NULL,
      guidance jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS secops_artifacts (
      id text PRIMARY KEY,
      session_id text NOT NULL REFERENCES secops_sessions(id) ON DELETE CASCADE,
      run_id text NOT NULL REFERENCES secops_runs(id) ON DELETE CASCADE,
      tool_call_id text,
      artifact jsonb NOT NULL,
      created_at timestamptz NOT NULL
    );

    CREATE TABLE IF NOT EXISTS secops_audit_events (
      id text PRIMARY KEY,
      session_id text NOT NULL REFERENCES secops_sessions(id) ON DELETE CASCADE,
      run_id text NOT NULL REFERENCES secops_runs(id) ON DELETE CASCADE,
      audit jsonb NOT NULL,
      created_at timestamptz NOT NULL
    );

    CREATE TABLE IF NOT EXISTS secops_state_markers (
      id text PRIMARY KEY,
      session_id text NOT NULL REFERENCES secops_sessions(id) ON DELETE CASCADE,
      run_id text NOT NULL REFERENCES secops_runs(id) ON DELETE CASCADE,
      key text NOT NULL,
      value jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS secops_pending_approvals (
      id text PRIMARY KEY,
      session_id text REFERENCES secops_sessions(id) ON DELETE CASCADE,
      run_id text NOT NULL,
      approval jsonb NOT NULL,
      invocation jsonb,
      context jsonb,
      status text NOT NULL DEFAULT 'pending',
      requested_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      decided_at timestamptz
    );

    CREATE INDEX IF NOT EXISTS secops_runs_session_id_idx ON secops_runs(session_id);
    CREATE INDEX IF NOT EXISTS secops_messages_session_run_idx ON secops_messages(session_id, run_id);
    CREATE INDEX IF NOT EXISTS secops_tool_invocations_session_run_idx ON secops_tool_invocations(session_id, run_id);
    CREATE INDEX IF NOT EXISTS secops_tool_guidance_session_run_idx ON secops_tool_guidance(session_id, run_id);
    CREATE INDEX IF NOT EXISTS secops_artifacts_session_run_idx ON secops_artifacts(session_id, run_id);
    CREATE INDEX IF NOT EXISTS secops_audit_events_session_run_idx ON secops_audit_events(session_id, run_id);
    CREATE INDEX IF NOT EXISTS secops_state_markers_session_key_idx ON secops_state_markers(session_id, key);
    CREATE INDEX IF NOT EXISTS secops_pending_approvals_status_idx ON secops_pending_approvals(status, expires_at);
  `);
}

export async function withTransaction<T>(db: PGlite, operation: (tx: Transaction) => Promise<T>): Promise<T> {
  // PGlite's transaction() wraps BEGIN/COMMIT and rolls back automatically when
  // the callback throws, so the previous manual connect/BEGIN/COMMIT/ROLLBACK
  // dance is no longer needed.
  return db.transaction(async (tx) => operation(tx));
}
