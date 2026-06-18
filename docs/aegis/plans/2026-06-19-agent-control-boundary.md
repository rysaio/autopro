# Agent Control Boundary Implementation Plan

Goal: implement the `2026-06-19` Agent Control Boundary Design so the model
keeps flexible tool exploration while every interface enforces its own
business boundary, returns recoverable guidance for wrong order or missing
context, and persists session/run state in Postgres as the recoverable source
of truth.

Architecture: host-owned lifecycle and storage contract. `apps/server` keeps
PolicyGate, approval, audit, runtime, API, MCP, and Postgres session ownership.
Plugins keep domain behavior and preconditions. The AI SDK still owns the
model/tool loop. The frontend renders host state; it does not become the source
of truth.

Tech Stack: TypeScript ESM, Fastify, AI SDK, Vitest, PostgreSQL, `pg`, existing
JSON schema manifests, React/Vite console.

Baseline/Authority Refs:

- `docs/aegis/specs/2026-06-19-agent-control-boundary-design.md`
- `docs/architecture.md`
- `README.md`
- `docs/aegis/work/2026-06-14-secops-agent-web/SUMMARY.md`
- `docs/aegis/work/2026-06-15-wazuh-plugin-extraction/SUMMARY.md`
- `docs/aegis/work/2026-06-16-shuffle-secops-plugin/SUMMARY.md`

Compatibility Boundary:

- Do not add a fixed workflow engine before model execution.
- Preserve current tool IDs, model API names, and MCP endpoints. This plan may
  add optional compatible fields and new session routes.
- Keep invalid arguments failing before policy and approval persistence.
- Keep `observe`, `sandbox`, and `full-access` action behavior intact.
- Keep plugins free of host approval-store, web UI, and Postgres imports.
- Keep local JSONL as a trace/export only; Postgres is the durable source of
  truth for first-scope completion.
- Do not treat a mock or fake database as sufficient completion evidence.

Verification:

- `npm run test -w apps/server`
- `npm run test -w plugins/shuffle-secops`
- `npm run test -w plugins/wazuh-secops`
- `npm run typecheck`
- A real Postgres integration check that proves session, run, message,
  guidance, approval, artifact, state marker, and audit recovery after restart.
- Manual web-console check for distinct guidance, denied, failed, and pending
  approval states.

## Plan Basis

Facts:

- `ToolRegistry` currently validates input, gates policy, persists pending
  approvals, executes tools, and returns `ToolExecutionRecord`.
- `AgentRuntime` currently emits run/tool/artifact/message/audit events and
  sends tool results back through AI SDK.
- `ApprovalStore` persists pending approvals to JSON files.
- `AuditLog` persists run events to JSONL.
- Shared `ToolInvocation.status` currently has no recoverable guidance state.
- `plugins/shuffle-secops` already has a high-risk
  `shuffle.workflow.execute` action and low-risk `shuffle.workflow.get` read
  tool, making it a good proof point for sequencing guidance.
- `apps/server` currently has no Postgres dependency or durable session store.

Assumptions:

- Local development can provide `SECOPS_DATABASE_URL` for real Postgres.
- Tests may use a short-lived Postgres schema/database when available, but
  should skip with an explicit message when no integration database is
  configured.
- API compatibility is easier if the first implementation adds structured
  guidance in optional fields while retaining existing status strings.

Unknowns:

- Final production Postgres deployment method.
- Whether existing UI session buttons should become fully server-backed in the
  same visual pass or only after API routes are available.

## BaselineUsageDraft

- Required baseline refs:
  - `docs/aegis/specs/2026-06-19-agent-control-boundary-design.md`
  - `docs/architecture.md`
  - `README.md`
- Delivered context refs: current code under `apps/server`, `apps/web`,
  `packages/shared`, `plugins/shuffle-secops`.
- Acknowledged before plan refs:
  - host owns policy/approval/audit/runtime/UI integration
  - plugins own domain behavior
  - durable chat/run storage was missing and is now in first scope
- Cited in plan refs: design spec and architecture docs above.
- Missing refs: no ADR yet; create after implementation if accepted.
- Decision: continue.

## Architecture Integrity Lens

- Invariant: a tool call that cannot execute must still produce an auditable,
  recoverable state unless the error is malformed input or unrecoverable
  platform failure.
- Canonical owner / contract: shared contracts define guidance and lifecycle
  shapes; `apps/server` owns runtime recording and Postgres storage;
  plugins own domain preconditions.
- Responsibility overlap: existing `ApprovalStore` and `AuditLog` JSON files
  overlap with Postgres until retired or downgraded to secondary trace/export.
- Higher-level simplification: introduce a `SessionStateStore` interface so
  runtime/registry call one owner instead of scattering database writes.
- Retirement / falsifier: JSON approval files cannot remain the authoritative
  approval recovery path after Postgres slice lands. If tests show replay still
  depends on JSON files, the architecture is incomplete.
- Verdict: proceed, but explicitly govern JSON store retirement.

## Plan Pressure Test

- Owner / contract / retirement: high pressure; new shared contracts and
  Postgres source of truth affect server, web, and tests.
- Architecture integrity / higher-level path: use a session-state abstraction
  rather than wiring SQL calls into `ToolRegistry` or tool handlers.
- Verification scope: unit tests are not enough; require real Postgres
  integration evidence.
- Task executability: split into contract, lifecycle, proof-point, storage,
  recovery/UI, and verification slices.
- Pressure result: proceed with a durable plan, not a planless slice.

## Complexity Budget

- Artifact class: Source Complexity, Test Complexity, Decision / Plan
  Complexity.
- Target files / artifacts:
  - `packages/shared/src/index.ts`
  - `apps/server/src/tools/registry.ts`
  - `apps/server/src/runtime/agentRuntime.ts`
  - new `apps/server/src/runtime/sessionStateStore.ts`
  - new `apps/server/src/runtime/postgresSessionStore.ts`
  - new `apps/server/src/runtime/postgresMigrations.ts`
  - `apps/server/src/runtime/approvalStore.ts`
  - `apps/server/src/runtime/auditLog.ts`
  - `apps/server/src/app.ts`
  - `apps/server/src/config.ts`
  - `plugins/shuffle-secops/src/tools/registry.ts`
  - `apps/web/src/App.tsx`
  - `apps/web/src/api.ts`
  - new and existing server/plugin/web tests
- Current pressure: `app.ts`, `registry.ts`, `agentRuntime.ts`, and
  `plugins/shuffle-secops/src/tools/registry.ts` are central owner files that
  already carry multiple responsibilities.
- Projected post-change pressure: at-risk if database and guidance logic is
  added in place.
- Budget result: at-risk.
- Planned governance: add dedicated runtime/storage owner files, keep plugin
  proof-point local, and avoid SQL inside registry/tool handlers.

## Plan-Time Complexity Check

- Target files: see budget above.
- Existing size / shape signals: server app wires many routes and stores;
  registry owns validation/policy/approval/execution; Shuffle registry is a
  large tool manifest/handler file.
- Owner fit: shared types in `packages/shared`; lifecycle orchestration in
  server runtime; domain precondition in Shuffle plugin; rendering in web.
- Add-in-place risk: high for SQL in registry/runtime and guidance rendering
  hidden inside existing activity list logic.
- Better file boundary: `SessionStateStore` plus `PostgresSessionStore`;
  guidance helpers in shared/server tools; a focused web component/helper for
  guidance display.
- Recommendation: add owner files for persistence and guidance helpers; edit
  existing orchestration files only at integration points.

## Task 1: Shared Recoverable Guidance Contract

Files:

- Modify `packages/shared/src/index.ts`
- Modify `apps/server/test/registry.test.ts`
- Modify `apps/server/test/agentRuntime.test.ts`

Why: give runtime, tools, API, and UI a typed, model-usable guidance shape
without requiring callers to parse error strings.

Impact/Compatibility:

- Add optional fields and new types; keep existing status values compatible
  until all consumers are reviewed.
- Do not require plugins to import server-only types.

Verification:

- `npm run test -w @secops-agent/shared`
- `npm run test -w apps/server -- registry.test.ts agentRuntime.test.ts`

Steps:

1. Write tests expecting a guidance-capable invocation shape.
   Add assertions in `apps/server/test/registry.test.ts` that a future helper
   can return `invocation.result.guidance.message` and `recoverable: true`
   while preserving `invocation.status === "failed"` for compatibility.
2. Verify RED:
   `npm run test -w apps/server -- registry.test.ts`
3. Add shared types in `packages/shared/src/index.ts`:

   ```ts
   export type ToolGuidanceKind = "precondition" | "missing_context" | "policy" | "validation";

   export interface ToolGuidanceNextTool {
     toolName: string;
     reason: string;
     suggestedArgs?: Record<string, unknown>;
   }

   export interface ToolGuidance {
     kind: ToolGuidanceKind;
     message: string;
     nextTools?: ToolGuidanceNextTool[];
     requiredState?: string[];
     recoverable: boolean;
   }

   export interface RecoverableToolResult {
     status: "needs_precondition" | "needs_context";
     guidance: ToolGuidance;
   }
   ```

   Add optional `guidance?: ToolGuidance` to `ToolInvocation`.
4. Verify GREEN:
   `npm run test -w @secops-agent/shared`
   `npm run test -w apps/server -- registry.test.ts agentRuntime.test.ts`
5. Commit:
   `git add packages/shared/src/index.ts apps/server/test/registry.test.ts apps/server/test/agentRuntime.test.ts`
   `git commit -m "feat: add recoverable tool guidance contract"`

## Task 2: Registry and Runtime Guidance Flow

Files:

- Create `apps/server/src/tools/guidance.ts`
- Modify `apps/server/src/tools/types.ts`
- Modify `apps/server/src/tools/registry.ts`
- Modify `apps/server/src/runtime/agentRuntime.ts`
- Modify `apps/server/src/runtime/systemPrompt.ts`
- Modify `apps/server/test/registry.test.ts`
- Modify `apps/server/test/agentRuntime.test.ts`
- Modify `apps/server/test/agentEvents.test.ts`

Why: make recoverable tool outcomes visible to the model, audit stream, and
events without changing policy ownership.

Impact/Compatibility:

- `ToolExecutionResult` may carry structured guidance.
- `ToolRegistry` maps recoverable outcomes to compatible invocations.
- Runtime emits `tool_result` and a guidance-specific audit detail.
- Policy decisions still occur before side-effecting execution.

Verification:

- `npm run test -w apps/server -- registry.test.ts agentRuntime.test.ts agentEvents.test.ts`
- `npm run test -w apps/server`

Steps:

1. Write tests:
   - a custom test tool returns a recoverable guidance result
   - registry returns `status: "failed"`, `result.guidance`, and
     `invocation.guidance`
   - runtime tool message includes the structured guidance JSON for the next
     model round
   - event stream contains a tool event and audit event mentioning guidance
2. Verify RED:
   `npm run test -w apps/server -- registry.test.ts agentRuntime.test.ts agentEvents.test.ts`
3. Implement `apps/server/src/tools/guidance.ts`:

   ```ts
   import type { RecoverableToolResult, ToolGuidance } from "@secops-agent/shared";

   export function needsPrecondition(guidance: ToolGuidance): RecoverableToolResult {
     return { status: "needs_precondition", guidance };
   }

   export function needsContext(guidance: ToolGuidance): RecoverableToolResult {
     return { status: "needs_context", guidance };
   }

   export function isRecoverableToolResult(value: unknown): value is RecoverableToolResult {
     return Boolean(
       value &&
       typeof value === "object" &&
       "status" in value &&
       ((value as { status?: unknown }).status === "needs_precondition" ||
         (value as { status?: unknown }).status === "needs_context") &&
       "guidance" in value
     );
   }
   ```

4. Update `ToolExecutionResult` to allow recoverable output. In
   `ToolRegistry.executeApiTool`, after `tool.execute`, detect
   `isRecoverableToolResult(result.output)` and return a compatible failed
   invocation with `result: result.output`, `guidance:
   result.output.guidance`, and no artifacts when the handler did not return
   artifacts.
5. Update `AgentRuntime` audit detail so recoverable guidance is not treated as
   an opaque runtime exception. Add a system prompt line: "When a tool returns
   recoverable guidance, follow it before retrying the blocked action unless
   the analyst goal has changed."
6. Verify GREEN:
   `npm run test -w apps/server -- registry.test.ts agentRuntime.test.ts agentEvents.test.ts`
   `npm run test -w apps/server`
7. Commit:
   `git add apps/server/src/tools/guidance.ts apps/server/src/tools/types.ts apps/server/src/tools/registry.ts apps/server/src/runtime/agentRuntime.ts apps/server/src/runtime/systemPrompt.ts apps/server/test/registry.test.ts apps/server/test/agentRuntime.test.ts apps/server/test/agentEvents.test.ts`
   `git commit -m "feat: return recoverable tool guidance"`

## Task 3: Shuffle Precondition Proof Point

Files:

- Modify `plugins/shuffle-secops/src/tools/types.ts`
- Modify `plugins/shuffle-secops/src/tools/registry.ts`
- Modify `plugins/shuffle-secops/test/tools.test.ts`

This task does not add an app-server Shuffle adapter. The proof point stays in
the canonical `plugins/shuffle-secops` owner. A later app integration can adapt
the already-guidance-capable plugin tools.

Why: prove interface-local business/precondition logic lives in the plugin and
returns model-usable guidance without host domain branching.

Impact/Compatibility:

- Keep `shuffle.workflow.execute` action-classed and approval-owned by the
  host.
- Do not import `ApprovalStore`, `AuditLog`, Fastify, or Postgres from the
  plugin.
- Do not make this proof point block all valid Shuffle executions. It should
  require either confirmed workflow metadata state from `context.stateMarkers`
  or explicit execution argument confirmation in the call.

Verification:

- `npm run test -w plugins/shuffle-secops`
- `npm run test -w apps/server` if server adapter is touched

Steps:

1. Write plugin tests:
   - executing a workflow without confirmation returns recoverable guidance
     pointing to `shuffle.workflow.get`
   - executing with an explicit confirmation marker proceeds to client call
   - guidance output contains no API key or webhook secret
2. Verify RED:
   `npm run test -w plugins/shuffle-secops -- tools.test.ts`
3. Add host-neutral guidance-compatible types to
   `plugins/shuffle-secops/src/tools/types.ts` matching shared shape without
   importing shared. Extend `ShuffleExecutionContext` with optional
   `stateMarkers?: string[]`.
4. Update `shuffle.workflow.get` to return a state marker such as
   `shuffle.workflow.metadata:<workflowId>`.
5. Update `shuffle.workflow.execute`:
   - read `context.stateMarkers`
   - when the metadata marker is missing and no explicit confirmation argument
     is present, return this complete output:

     ```ts
     {
       status: "needs_precondition",
       guidance: {
         kind: "precondition",
         message: "Call shuffle.workflow.get before shuffle.workflow.execute so the workflow target and expected arguments are known.",
         nextTools: [
           {
             toolName: "shuffle.workflow.get",
             reason: "Fetch workflow metadata before execution.",
             suggestedArgs: { workflowId }
           }
         ],
         requiredState: [`shuffle.workflow.metadata:${workflowId}`],
         recoverable: true
       }
     }
     ```

   - when the marker or explicit confirmation is present, execute as before
6. Verify GREEN:
   `npm run test -w plugins/shuffle-secops`
7. Commit:
   `git add plugins/shuffle-secops/src/tools/types.ts plugins/shuffle-secops/src/tools/registry.ts plugins/shuffle-secops/test/tools.test.ts`
   `git commit -m "feat: guide shuffle workflow preconditions"`

## Task 4: Session State Store Interface

Files:

- Create `apps/server/src/runtime/sessionStateStore.ts`
- Modify `apps/server/src/runtime/agentRuntime.ts`
- Modify `apps/server/src/tools/types.ts`
- Modify `apps/server/src/tools/registry.ts`
- Modify `apps/server/test/agentRuntime.test.ts`
- Modify `apps/server/test/approval.test.ts`

Why: give runtime/registry one host-owned persistence interface before adding
SQL, avoiding database writes scattered across orchestration code.

Impact/Compatibility:

- Existing tests can use an in-memory implementation.
- Tool handlers receive state markers through `ToolContext` but do not write to
  storage directly.
- Approval JSON store may still exist until Postgres task replaces the
  authoritative recovery path.

Verification:

- `npm run test -w apps/server -- agentRuntime.test.ts approval.test.ts registry.test.ts`

Steps:

1. Write tests with an in-memory `SessionStateStore`:
   - `run_started` and `run_completed` are recorded
   - tool invocation records include guidance and artifacts
   - state markers from a tool result become available to later tool calls in
     the same run
2. Verify RED:
   `npm run test -w apps/server -- agentRuntime.test.ts registry.test.ts`
3. Create `sessionStateStore.ts` with:

   ```ts
   import type { AgentRun, AgentRunEvent, AuditEvent, ChatMessage, EvidenceArtifact, ToolGuidance, ToolInvocation } from "@secops-agent/shared";

   export interface StateMarker {
     id: string;
     sessionId: string;
     runId: string;
     key: string;
     value: unknown;
     createdAt: string;
   }

   export interface SessionStateStore {
     startRun(input: { sessionId: string; runId: string; startedAt: string }): Promise<void>;
     appendMessage(sessionId: string, runId: string, message: ChatMessage): Promise<void>;
     recordToolInvocation(sessionId: string, runId: string, invocation: ToolInvocation, artifacts: EvidenceArtifact[]): Promise<void>;
     recordGuidance(sessionId: string, runId: string, toolCallId: string, guidance: ToolGuidance): Promise<void>;
     recordAuditEvent(sessionId: string, runId: string, audit: AuditEvent): Promise<void>;
     recordRunEvent(event: AgentRunEvent): Promise<void>;
     recordStateMarkers(sessionId: string, runId: string, markers: Array<Omit<StateMarker, "id" | "sessionId" | "runId" | "createdAt">>): Promise<void>;
     listStateMarkers(sessionId: string): Promise<StateMarker[]>;
     completeRun(sessionId: string, run: AgentRun): Promise<void>;
   }

   export class NoopSessionStateStore implements SessionStateStore {
     async startRun(): Promise<void> {}
     async appendMessage(): Promise<void> {}
     async recordToolInvocation(): Promise<void> {}
     async recordGuidance(): Promise<void> {}
     async recordAuditEvent(): Promise<void> {}
     async recordRunEvent(): Promise<void> {}
     async recordStateMarkers(): Promise<void> {}
     async listStateMarkers(): Promise<StateMarker[]> { return []; }
     async completeRun(): Promise<void> {}
   }

   export class MemorySessionStateStore implements SessionStateStore {
     readonly markers: StateMarker[] = [];
     readonly events: AgentRunEvent[] = [];
     readonly messages: ChatMessage[] = [];
     readonly invocations: ToolInvocation[] = [];
     readonly guidance: ToolGuidance[] = [];
     async startRun(): Promise<void> {}
     async appendMessage(_sessionId: string, _runId: string, message: ChatMessage): Promise<void> { this.messages.push(message); }
     async recordToolInvocation(_sessionId: string, _runId: string, invocation: ToolInvocation): Promise<void> { this.invocations.push(invocation); }
     async recordGuidance(_sessionId: string, _runId: string, _toolCallId: string, guidance: ToolGuidance): Promise<void> { this.guidance.push(guidance); }
     async recordAuditEvent(): Promise<void> {}
     async recordRunEvent(event: AgentRunEvent): Promise<void> { this.events.push(event); }
     async recordStateMarkers(sessionId: string, runId: string, markers: Array<Omit<StateMarker, "id" | "sessionId" | "runId" | "createdAt">>): Promise<void> {
       for (const marker of markers) {
         this.markers.push({ id: crypto.randomUUID(), sessionId, runId, createdAt: new Date().toISOString(), ...marker });
       }
     }
     async listStateMarkers(sessionId: string): Promise<StateMarker[]> { return this.markers.filter((marker) => marker.sessionId === sessionId); }
     async completeRun(): Promise<void> {}
   }
   ```

4. Add `sessionId?: string` to `AgentRunRequest`; runtime creates one when
   omitted. Pass state markers into `ToolContext`.
5. Update `AgentRuntime` and `ToolRegistry` integration points to record run,
   messages, tool invocations, guidance, artifacts, state markers, and audit.
6. Verify GREEN:
   `npm run test -w apps/server -- agentRuntime.test.ts registry.test.ts approval.test.ts`
7. Commit:
   `git add apps/server/src/runtime/sessionStateStore.ts apps/server/src/runtime/agentRuntime.ts apps/server/src/tools/types.ts apps/server/src/tools/registry.ts apps/server/test/agentRuntime.test.ts apps/server/test/registry.test.ts apps/server/test/approval.test.ts packages/shared/src/index.ts`
   `git commit -m "feat: add session state store boundary"`

## Task 5: Postgres Store and Migrations

Files:

- Modify `apps/server/package.json`
- Modify root `package-lock.json`
- Modify `.env.example`
- Modify `apps/server/src/config.ts`
- Create `apps/server/src/runtime/postgresMigrations.ts`
- Create `apps/server/src/runtime/postgresSessionStore.ts`
- Create `apps/server/test/postgresSessionStore.test.ts`
- Create `apps/server/test/fixtures/postgres.ts`

Why: make Postgres the durable recoverable source of truth for sessions, runs,
messages, tool invocations, guidance, approvals, artifacts, state markers, and
audit events.

Impact/Compatibility:

- Add `SECOPS_DATABASE_URL`.
- If database URL is missing, health must report durable session storage as
  unavailable and server may use local/noop storage only for development
  modes that explicitly permit degraded operation.
- Completion evidence requires real Postgres integration tests.

Verification:

- `npm install`
- `npm run test -w apps/server -- postgresSessionStore.test.ts`
- Real Postgres run with `SECOPS_TEST_DATABASE_URL` set.

Steps:

1. Write integration tests:
   - initialize schema
   - store and restore session/run/message/tool/guidance/approval/artifact/audit
   - verify transaction rollback prevents contradictory partial tool state
   - verify restart by creating a second `PostgresSessionStore` instance over
     the same database and reading prior state
2. Verify RED:
   `npm run test -w apps/server -- postgresSessionStore.test.ts`
3. Add dependency:
   `npm install pg @types/pg -w apps/server`
4. Add config:
   - `databaseUrl?: string`
   - `durableSessionMode: "postgres" | "disabled"`
   - env var `SECOPS_DATABASE_URL`
5. Implement migrations with `CREATE TABLE IF NOT EXISTS` for:
   - `secops_sessions`
   - `secops_runs`
   - `secops_messages`
   - `secops_tool_invocations`
   - `secops_tool_guidance`
   - `secops_artifacts`
   - `secops_audit_events`
   - `secops_state_markers`
   - `secops_pending_approvals`
6. Implement `PostgresSessionStore` using `pg.Pool`, JSONB for structured
   payloads, immutable audit inserts, and transactions for one tool invocation.
7. Verify GREEN:
   `npm run test -w apps/server -- postgresSessionStore.test.ts`
8. Commit:
   `git add apps/server/package.json package-lock.json .env.example apps/server/src/config.ts apps/server/src/runtime/postgresMigrations.ts apps/server/src/runtime/postgresSessionStore.ts apps/server/test/postgresSessionStore.test.ts apps/server/test/fixtures/postgres.ts`
   `git commit -m "feat: persist agent sessions in postgres"`

## Task 6: App Wiring, Approval Recovery, and Health

Files:

- Modify `apps/server/src/app.ts`
- Modify `apps/server/src/index.ts`
- Modify `apps/server/src/runtime/approvalStore.ts`
- Modify `apps/server/src/runtime/auditLog.ts`
- Modify `apps/server/src/runtime/postgresSessionStore.ts`
- Modify `apps/server/test/approval.test.ts`
- Modify `apps/server/test/auditLog.test.ts`
- Modify `apps/server/test/agentRequest.test.ts`
- Modify `apps/server/test/config.test.ts`

Why: make Postgres authoritative for durable recovery while keeping local JSONL
as secondary trace/export.

Impact/Compatibility:

- `/api/approvals` reads Postgres-backed pending approvals when configured.
- Approve/deny consumes Postgres pending approval records once.
- JSON approval file path is retained only for degraded compatibility and
  should not be used when Postgres is configured.
- `/api/health` reports durable session store status.

Verification:

- `npm run test -w apps/server -- approval.test.ts auditLog.test.ts agentRequest.test.ts config.test.ts`
- Real Postgres restart test with two app instances.

Steps:

1. Write tests:
   - with Postgres configured, pending approval persists across app instances
     without JSON approval file
   - deny consumes pending approval in Postgres
   - approve executes once and records approval audit/message state
   - health reports durable storage configured/unavailable states
2. Verify RED:
   `npm run test -w apps/server -- approval.test.ts config.test.ts`
3. Wire store creation in `buildServer`:
   - initialize migrations at startup when `SECOPS_DATABASE_URL` is set
   - pass `SessionStateStore` into `AgentRuntime` and `ToolRegistry`
   - pass Postgres approval adapter to registry
4. Refactor `ApprovalStore` behind this interface:

   ```ts
   export interface PendingApprovalStore {
     add(record: StoredApproval): PendingApproval;
     list(): PendingApproval[];
     get(id: string): StoredApproval | undefined;
     take(id: string): StoredApproval | undefined;
     deny(id: string): ApprovalDecisionResult | undefined;
   }
   ```

   Use async method signatures in the interface so the JSON and Postgres
   implementations share the same contract. Update all registry call sites to
   await store methods deliberately.
5. Keep `AuditLog.append` as local trace/export but record audit events through
   `SessionStateStore` as the durable path.
6. Verify GREEN:
   `npm run test -w apps/server -- approval.test.ts auditLog.test.ts agentRequest.test.ts config.test.ts`
   `npm run test -w apps/server`
7. Commit:
   `git add apps/server/src/app.ts apps/server/src/index.ts apps/server/src/runtime/approvalStore.ts apps/server/src/runtime/auditLog.ts apps/server/src/runtime/postgresSessionStore.ts apps/server/test/approval.test.ts apps/server/test/auditLog.test.ts apps/server/test/agentRequest.test.ts apps/server/test/config.test.ts`
   `git commit -m "feat: recover approvals and runs from postgres"`

## Task 7: Session API and Web Guidance Rendering

Files:

- Modify `packages/shared/src/index.ts`
- Modify `apps/server/src/app.ts`
- Modify `apps/server/test/agentRequest.test.ts`
- Modify `apps/server/test/agentEvents.test.ts`
- Modify `apps/web/src/api.ts`
- Modify `apps/web/src/App.tsx`
- Modify `apps/web/src/styles.css`

Why: let analysts and the model-visible flow see durable sessions and
distinguish recoverable guidance from hard failures, denials, and approvals.

Impact/Compatibility:

- Add server-backed session list/get routes without removing existing run
  endpoints.
- Add `sessionId` to agent requests and responses.
- UI should not treat guidance as a terminal error.

Verification:

- `npm run test -w apps/server -- agentRequest.test.ts agentEvents.test.ts`
- `npm run test -w apps/web`
- Manual browser check when implementation is ready.

Steps:

1. Write tests:
   - `/api/sessions` lists stored sessions
   - `/api/sessions/:id` restores messages, tool invocations, artifacts,
     guidance, approvals, and audit
   - TypeScript-level web test coverage proves the UI compiles with guidance,
     session summary, and session detail types
2. Verify RED:
   `npm run test -w apps/server -- agentRequest.test.ts`
   `npm run test -w apps/web`
3. Add shared types for `AgentSessionSummary` and `AgentSessionDetail`.
4. Add API routes:
   - `GET /api/sessions`
   - `GET /api/sessions/:id`
5. Update web API client and App state so session rows come from server when
   durable storage is available.
6. Render guidance:
   - show `guidance.message`
   - show suggested next tools
   - visually distinguish guidance from hard failure and policy denial
7. Verify GREEN:
   `npm run test -w apps/server -- agentRequest.test.ts agentEvents.test.ts`
   `npm run test -w apps/web`
8. Commit:
   `git add packages/shared/src/index.ts apps/server/src/app.ts apps/server/test/agentRequest.test.ts apps/server/test/agentEvents.test.ts apps/web/src/api.ts apps/web/src/App.tsx apps/web/src/styles.css`
   `git commit -m "feat: expose durable sessions and guidance"`

## Task 8: End-to-End Verification, Docs, and ADR Signal

Files:

- Modify `README.md`
- Modify `.env.example`
- Modify `docs/architecture.md`
- Create `docs/aegis/work/2026-06-19-agent-control-boundary/SUMMARY.md`
- Modify `docs/aegis/INDEX.md`
- Create `docs/aegis/adr/2026-06-19-agent-control-boundary.md`

Why: prove the full objective against current state and preserve the durable
architecture decision for future agents.

Impact/Compatibility:

- Documentation must state Postgres is the source of truth for durable session
  recovery.
- Keep sandboxed web/root Vite build caveat from existing docs.

Verification:

- `npm run test -w apps/server`
- `npm run test -w plugins/shuffle-secops`
- `npm run test -w plugins/wazuh-secops`
- `npm run typecheck`
- real Postgres integration check
- manual web guidance/recovery check

Steps:

1. Run the full automated suite:
   `npm run test -w apps/server`
   `npm run test -w plugins/shuffle-secops`
   `npm run test -w plugins/wazuh-secops`
   `npm run typecheck`
2. Run real Postgres recovery verification:
   - start with `SECOPS_DATABASE_URL` or `SECOPS_TEST_DATABASE_URL`
   - create a session and ask-mode action approval
   - restart app/server instance
   - verify session, guidance, audit, artifacts, and approval restore from
     Postgres
3. Run manual web check:
   - open console
   - produce recoverable Shuffle guidance
   - produce observe-mode denial
   - produce invalid-input failure
   - produce ask-mode pending approval
   - confirm UI states are distinct and no credential leakage appears
4. Update docs and work summary with exact commands and results.
   Create `docs/aegis/adr/` as the project ADR folder if it is still missing.
5. Commit:
   `git add README.md .env.example docs/architecture.md docs/aegis/INDEX.md docs/aegis/work/2026-06-19-agent-control-boundary/SUMMARY.md docs/aegis/adr/2026-06-19-agent-control-boundary.md`
   `git commit -m "docs: record agent control boundary verification"`

## Risks

- Postgres availability can slow development. Mitigation: use explicit
  `SECOPS_TEST_DATABASE_URL` integration tests and clear degraded health when
  missing, but do not claim completion without real Postgres evidence.
- Approval recovery refactor can accidentally weaken PolicyGate. Mitigation:
  keep existing approval tests and add Postgres restart coverage before
  replacing JSON authority.
- Guidance could become hidden workflow orchestration. Mitigation: guidance is
  returned by interface-local checks and remains optional model input, not a
  host pre-execution path planner.
- Frontend state may drift from server state. Mitigation: server session routes
  become source of truth; UI fetches rather than reconstructing from local-only
  memory.

## Repair Track

- Repair object: missing recoverable control-boundary contract and missing
  durable session source of truth.
- Canonical owner: shared contracts plus `apps/server` runtime/storage.
- Minimal sufficient stable repair: typed guidance outcomes, state markers,
  Postgres session store, approval recovery, and UI/API rendering.
- Compatibility boundary: existing tool IDs, approval semantics, action levels,
  and plugin ownership remain intact.
- Verification: server/plugin/web tests, typecheck, and real Postgres restart
  recovery evidence.

## Retirement Track

- Old owner/fallback: JSON approval file and local JSONL audit as de facto
  recovery source.
- Active status: retained only as compatibility/export/degraded trace after
  Postgres is configured.
- Keep reason: local development trace and backward compatibility.
- Deletion trigger: after Postgres-backed recovery is stable and docs no longer
  direct operators to JSON files as authoritative recovery.

## ADR / Baseline Sync

ADR signal is required because this work changes:

- shared public contract shape
- lifecycle event taxonomy
- host/plugin responsibility boundary
- Postgres source-of-truth boundary
- frontend interpretation of tool outcomes

After implementation and verification, record an ADR or equivalent baseline
sync that names the accepted source-of-truth boundary and the status of JSON
approval/audit files.
