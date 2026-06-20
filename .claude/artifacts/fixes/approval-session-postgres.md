# Bug: Postgres session approval failed after MCP pending call

> Status: FIXED
> Mode: default
> Severity: blocker
> Author: Codex
> Last updated: 2026-06-19

## Symptom

When a web MCP tool call sent a `sessionId`, the pending approval was created,
but approving it returned HTTP 500 while the action had already executed.

## Expected

Approving a pending MCP action with a durable session should execute once,
return 200, and persist the approval messages, audit events, and tool
invocation under the session.

## Reproduction

- Test: `apps/server/test/approval.test.ts`
- Case: `approves postgres-backed MCP calls that carry a session id`
- Red result: approval returned 500 with `secops_audit_events_run_id_fkey`.

## Hypotheses & Diagnosis

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| H1 | Direct MCP calls with `sessionId` create pending approvals without a corresponding `secops_runs` row. | confirmed | Repro showed audit insert failed because the approval `run_id` was absent from `secops_runs`. |
| H2 | Approval consumption can hand the same pending call to more than one consumer. | confirmed | New concurrent `ApprovalStore.take()` test returned two records before the fix. |

## Root Cause

`PostgresSessionStore.add()` stored pending approvals with `session_id` and
`run_id`, but only inserted `secops_sessions`. Agent runs already call
`startRun()`, but standalone MCP/tool invocations do not, so later approval
audit/tool persistence violated the run foreign key. Separately, both approval
stores read the pending record before consuming it, leaving a race window.

## Fix

- `apps/server/src/runtime/postgresSessionStore.ts`: insert a `needs_approval`
  run row when a pending approval carries `sessionId`, and consume pending rows
  with one atomic `UPDATE ... RETURNING`.
- `apps/server/src/runtime/approvalStore.ts`: remove the async read-before-delete
  window from file-backed `take()`.
- `apps/server/test/approval.test.ts`: add regressions for Postgres MCP
  session approval and single-consumer approval semantics.

## Verification

- V-1: `npm run test -w @secops-agent/server -- approval.test.ts -t "consumes file-backed pending approvals at most once"` failed before fix, passed after fix.
- V-2: `npm run test:postgres` failed before fix with 500/FK violation, passed after fix with 3 files and 19 tests.
- V-3: `npm run test -w @secops-agent/server -- approval.test.ts` passed with 11 tests.

## Pattern Analysis

The same bug class is "pending side-effect approval has durable session state
but no canonical run owner". The fix keeps ownership in the stores rather than
patching the web client or approval endpoint.

## Follow-ups

- Consider whether standalone direct MCP/tool calls should produce full
  `AgentRun` records, or remain represented only by messages, tool invocations,
  audit, and session counters.
