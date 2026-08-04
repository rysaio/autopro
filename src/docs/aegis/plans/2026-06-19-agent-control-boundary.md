# Agent Control Boundary Implementation Plan

Goal: implement the `2026-06-19` Agent Control Boundary Design so the model
keeps flexible tool exploration while every interface enforces its own business
boundary, returns recoverable guidance for wrong order or missing context, and
persists session/run state in a durable store as the recoverable source of
truth.

Architecture: host-owned lifecycle and storage contract. `apps/server` keeps
PolicyGate, approval, audit, runtime, API, MCP, and durable session ownership.
Plugins keep domain behavior and preconditions. The AI SDK still owns the
model/tool loop. The frontend renders host state; it does not become the source
of truth.

Storage: durable sessions run on an embedded PGlite store in-process
(`SECOPS_DATA_DIR`, default `runtime/pgdata`; `memory://` for ephemeral;
`SECOPS_DURABLE_SESSIONS=off` to disable). See
`../adr/2026-06-27-embedded-pglite-durable-sessions.md`. The store is already
implemented; this plan does not re-specify it.

Tech Stack: TypeScript ESM, Fastify, AI SDK, Vitest, React/Vite console.

Compatibility Boundary:

- Do not add a fixed workflow engine before model execution.
- Preserve current tool IDs, model API names, and MCP endpoints.
- Keep invalid arguments failing before policy and approval persistence.
- Keep `observe`, `sandbox`, and `full-access` action behavior intact.
- Keep plugins free of host approval-store, web UI, and storage imports.
- Keep local JSONL as a trace/export only; the durable store is the source of
  truth.

Verification:

- `npm run test -w apps/server`
- `npm run test -w plugins/shuffle-secops`
- `npm run test -w plugins/wazuh-secops`
- `npm run typecheck`
- Manual web-console check for distinct guidance, denied, failed, and pending
  approval states.

## Task 1: Shared Recoverable Guidance Contract

Files: `packages/shared/src/index.ts`; `apps/server/test/registry.test.ts`;
`apps/server/test/agentRuntime.test.ts`.

Why: give runtime, tools, API, and UI a typed, model-usable guidance shape
without requiring callers to parse error strings.

Steps:

1. Add shared types: `ToolGuidanceKind` (`"precondition" | "missing_context" |
   "policy" | "validation"`), `ToolGuidanceNextTool`, `ToolGuidance`,
   `RecoverableToolResult`, and optional `guidance?: ToolGuidance` on
   `ToolInvocation`.
2. Keep existing status values compatible; do not require plugins to import
   server-only types.

Verify: `npm run test -w @secops-agent/shared`; `npm run test -w apps/server --
registry.test.ts agentRuntime.test.ts`.

## Task 2: Registry and Runtime Guidance Flow

Files: create `apps/server/src/tools/guidance.ts`; modify `tools/types.ts`,
`tools/registry.ts`, `runtime/agentRuntime.ts`, `runtime/systemPrompt.ts`;
tests.

Why: make recoverable tool outcomes visible to the model, audit stream, and
events without changing policy ownership.

Steps:

1. Add `needsPrecondition` / `needsContext` helpers and an
   `isRecoverableToolResult` guard in `guidance.ts`.
2. In `ToolRegistry.executeApiTool`, detect recoverable results and return a
   compatible failed invocation with `result.guidance` populated; policy still
   runs before side effects.
3. Runtime emits `tool_result` and a guidance-specific audit detail; system
   prompt tells the model to follow guidance before retrying the blocked
   action.

Verify: `npm run test -w apps/server -- registry.test.ts agentRuntime.test.ts
agentEvents.test.ts`.

## Task 3: Shuffle Precondition Proof Point

Files: `plugins/shuffle-secops/src/tools/types.ts`;
`plugins/shuffle-secops/src/tools/registry.ts`;
`plugins/shuffle-secops/test/tools.test.ts`.

Why: prove interface-local business/precondition logic lives in the plugin and
returns model-usable guidance without host domain branching.

Steps:

1. `shuffle.workflow.get` returns a state marker
   `shuffle.workflow.metadata:<workflowId>`.
2. `shuffle.workflow.execute` reads `context.stateMarkers`; when the marker (or
   explicit confirmation arg) is missing, returns `needs_precondition` guidance
   pointing to `shuffle.workflow.get`; otherwise executes as before.
3. No `ApprovalStore`/`AuditLog`/Fastify/storage imports from the plugin;
   guidance output contains no API key or webhook secret.

Verify: `npm run test -w plugins/shuffle-secops`.

## Task 4: Session State Store Interface

Files: create `apps/server/src/runtime/sessionStateStore.ts`; modify
`runtime/agentRuntime.ts`, `tools/types.ts`, `tools/registry.ts`; tests.

Why: give runtime/registry one host-owned persistence interface, avoiding
storage writes scattered across orchestration code.

Steps:

1. Define `SessionStateStore` interface: `startRun`, `appendMessage`,
   `recordToolInvocation`, `recordGuidance`, `recordAuditEvent`,
   `recordRunEvent`, `recordStateMarkers`, `listStateMarkers`, `completeRun`.
2. Provide `NoopSessionStateStore` and `MemorySessionStateStore` for tests.
3. Add `sessionId?` to `AgentRunRequest`; runtime creates one when omitted.
   Pass state markers into `ToolContext`.
4. Wire `AgentRuntime` and `ToolRegistry` to record runs, messages,
   invocations, guidance, artifacts, state markers, and audit through the
   interface.

Verify: `npm run test -w apps/server -- agentRuntime.test.ts registry.test.ts
approval.test.ts`.

## Task 5: Approval Recovery and Health

Files: `apps/server/src/app.ts`; `runtime/approvalStore.ts`;
`runtime/auditLog.ts`; tests.

Why: make the durable store authoritative for approval recovery while keeping
local JSONL as secondary trace/export.

Steps:

1. Refactor `ApprovalStore` behind a `PendingApprovalStore` interface with
   async methods (`add`, `list`, `get`, `take`, `deny`); the durable-backed
   and JSON implementations share the contract.
2. `/api/approvals` reads durable-backed pending approvals; approve consumes
   the pending record once, deny consumes without invoking.
3. `AuditLog.append` stays a local trace; audit events are also recorded
   through `SessionStateStore` as the durable path.
4. `/api/health` reports durable session store status.

Verify: `npm run test -w apps/server -- approval.test.ts auditLog.test.ts
agentRequest.test.ts config.test.ts`.

## Task 6: Session API and Web Guidance Rendering

Files: `packages/shared/src/index.ts`; `apps/server/src/app.ts`;
`apps/web/src/api.ts`; `apps/web/src/App.tsx`; `apps/web/src/styles.css`;
tests.

Why: let analysts and the model-visible flow see durable sessions and
distinguish recoverable guidance from hard failures, denials, and approvals.

Steps:

1. Add shared types `AgentSessionSummary` and `AgentSessionDetail`.
2. Add routes `GET /api/sessions` and `GET /api/sessions/:id` restoring
   messages, invocations, artifacts, guidance, approvals, and audit.
3. Add `sessionId` to agent requests/responses; web client fetches session rows
   from server when durable storage is available.
4. Render guidance: show `guidance.message` and suggested next tools; visually
   distinguish from hard failure and policy denial.

Verify: `npm run test -w apps/server -- agentRequest.test.ts agentEvents.test.ts`;
`npm run test -w apps/web`.

## Task 7: End-to-End Verification

Steps:

1. Run the full automated suite: `npm run test -w apps/server`, plugin tests,
   `npm run typecheck`.
2. Run durable recovery verification: create a session and an ask-mode action
   approval, restart the app, verify session/guidance/audit/artifacts/approval
   restore from the durable store.
3. Manual web check: produce recoverable guidance, observe-mode denial,
   invalid-input failure, ask-mode pending approval; confirm UI states are
   distinct and no credential leakage.

## Risks

- Approval recovery refactor can accidentally weaken PolicyGate. Mitigation:
  keep existing approval tests and add durable restart coverage before treating
  JSON authority as retired.
- Guidance could become hidden workflow orchestration. Mitigation: guidance is
  returned by interface-local checks and remains optional model input, not a
  host pre-execution path planner.
- Frontend state may drift from server state. Mitigation: server session routes
  are source of truth; UI fetches rather than reconstructing from local-only
  memory.
