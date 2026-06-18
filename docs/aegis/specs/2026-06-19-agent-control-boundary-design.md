# Agent Control Boundary Design

Date: `2026-06-19`
Status: `draft for review`
ArchitectureReviewRequired: `yes`

## 1. Goal

Build a trust-the-model, control-the-boundary agent architecture for the
SecOps Agent Console.

The model should not be constrained by a fixed workflow before it acts. The
host should expose the usable interface surface, then each interface should
own its business boundary checks, lifecycle state markers, and precondition
checks. When the model calls tools in the wrong order or with missing context,
the interface should return a clear self-correction result such as "call A
first, then call B" instead of becoming a dead end.

The architecture must preserve flexible exploration while keeping business
flow, PolicyGate decisions, SecOps actions, and session state auditable,
recoverable, and safe.

## 2. Current Baseline

Authority references:

- `README.md`
- `docs/architecture.md`
- `docs/aegis/INDEX.md`
- `docs/aegis/work/2026-06-14-secops-agent-web/SUMMARY.md`
- `docs/aegis/work/2026-06-15-wazuh-plugin-extraction/SUMMARY.md`
- `docs/aegis/work/2026-06-16-shuffle-secops-plugin/SUMMARY.md`

Current owner boundaries:

- `apps/server` owns runtime, host policy, approval, audit, web API, app MCP,
  and UI integration.
- AI SDK owns the model/tool loop.
- `ToolRegistry` owns enabled-tool resolution, input validation, policy
  decision, pending approval persistence, and tool invocation recording.
- `ApprovalStore` owns pending side-effecting calls.
- `AuditLog` owns local JSONL event persistence.
- `plugins/wazuh-secops` owns Wazuh domain behavior.
- `plugins/shuffle-secops` owns Shuffle domain behavior.
- Durable chat/run storage and Postgres-backed session state are explicitly
  not implemented yet.

Baseline alignment:

- Requirement result: aligned. The root README already says this project is not
  a fixed script orchestrator; it should let the model operate inside controlled
  permission, audit, and tool-registration boundaries.
- Architecture result: aligned with one gap. Host-owned policy/approval/audit
  is established, but there is no first-class recoverable tool outcome or
  durable session state contract.

## 3. Non-Goals

- Do not introduce a fixed SOP engine that decides the model's reasoning path
  before model execution.
- Do not move approval ownership into Wazuh or Shuffle plugins.
- Do not let plugin-local logic bypass host PolicyGate, approval, or audit.
- Do not make frontend replay or approval UI the source of truth for tool
  state.
- Do not treat local JSONL audit or frontend memory as sufficient durable
  session state after the first implementation is complete.

## 4. First-Principles Review

First-principles invariants:

- Non-negotiable goal: every exposed interface either executes within its
  boundary or returns a structured, model-usable next step.
- Non-negotiable constraints: action policy remains host-owned; plugins remain
  domain owners; unsafe actions require the existing action level and approval
  gates; every state transition must be auditable.
- Historical assumptions to delete: "invalid sequence" is just failure;
  "tool error string" is enough; "session state can be reconstructed from UI
  memory"; "approval pending" is the only recoverable non-executed state.

Owner / retirement matrix:

- New canonical owner: host runtime contract for lifecycle outcomes and
  session state recording.
- Existing canonical owner retained: `ToolRegistry` for policy and tool
  invocation orchestration.
- Plugin responsibility retained: domain-specific preconditions and business
  boundary checks.
- Compat-only carrier: legacy tool `error` strings may remain for API
  compatibility, but structured guidance must become the authoritative shape
  for new recoverable states.
- Retirement trigger: after consumers render structured guidance, stop adding
  new behavior that depends only on parsing error text.

Falsification matrix:

- Dependency-removal test: a plugin should be able to declare a precondition
  without importing approval-store or web UI code.
- Counterexample scenario: model calls `shuffle.workflow.execute` without first
  discovering workflow details; result must tell it how to recover.
- Must fail / degrade / remain correct cases: malformed args still fail before
  approval persistence; observe mode still denies actions; approval survives
  restart from Postgres; if the configured durable store is unavailable, the
  host must report degraded or unavailable durable-session capability instead
  of pretending local audit is recoverable database state.

Verdict:

- Adopt the host lifecycle contract plus interface-local preconditions.
- Include Postgres-backed session/run storage in the first implementation
  scope so recoverability is proven against durable state, not only local
  runtime memory.

## 5. Architecture

### 5.1 Trust Model, Control Boundary

The model receives the available tool surface and chooses how to explore.

The host does not precompute a workflow graph for the model. Instead, it
controls the interfaces:

1. The host exposes only tools allowed by configured capability and action
   level.
2. The registry validates schema and policy before any side effect.
3. The tool or plugin checks domain preconditions and business boundaries.
4. The runtime records every outcome as lifecycle state.
5. Recoverable mismatches return structured guidance that the model can use in
   the next tool round.

### 5.2 Recoverable Tool Outcomes

Add a shared recoverable outcome concept without replacing existing invocation
statuses immediately.

Required result categories:

- `executed`: tool completed and returned evidence or action result.
- `pending_approval`: host accepted the call shape but requires analyst
  approval before execution.
- `denied`: host policy forbids execution in the current mode.
- `failed`: malformed input, runtime exception, or unrecoverable error.
- `needs_precondition`: call is valid, but required context or prior state is
  missing.
- `needs_context`: call needs an identifier, evidence artifact, session marker,
  or analyst-provided scope before it can proceed.

The public `ToolInvocation.status` can initially remain compatible with the
existing union by mapping `needs_precondition` and `needs_context` to
`failed` plus structured `result.guidance`. The implementation plan should
consider extending the shared status union once frontend/API compatibility is
reviewed.

Guidance payload shape:

```ts
interface ToolGuidance {
  kind: "precondition" | "missing_context" | "policy" | "validation";
  message: string;
  nextTools?: Array<{
    toolName: string;
    reason: string;
    suggestedArgs?: Record<string, unknown>;
  }>;
  requiredState?: string[];
  recoverable: boolean;
}
```

Example:

```json
{
  "status": "needs_precondition",
  "guidance": {
    "kind": "precondition",
    "message": "Call shuffle.workflow.get before shuffle.workflow.execute so the workflow target and expected arguments are known.",
    "nextTools": [
      {
        "toolName": "shuffle.workflow.get",
        "reason": "Fetch workflow metadata before execution.",
        "suggestedArgs": { "workflowId": "wf-123" }
      }
    ],
    "requiredState": ["workflow.metadata.confirmed"],
    "recoverable": true
  }
}
```

### 5.3 Interface-Local Preconditions

Each tool may expose optional precondition metadata and runtime checks.

Static metadata is advisory and model-visible:

- what state or evidence the tool benefits from
- what lower-risk tool can gather that state
- whether the tool is safe to call speculatively

Runtime checks are authoritative:

- validate domain boundaries
- reject unsafe missing context
- return guidance instead of throwing for recoverable sequencing problems
- still throw or fail for malformed input, client bugs, and unexpected
  platform errors

The host should not know Wazuh or Shuffle domain sequences. For example,
Shuffle owns "workflow metadata should precede execution"; Wazuh owns "explicit
agent IDs, duration, command allowlist, and reason are required for block IP".
The host owns how these outcomes are recorded, surfaced, approved, and audited.

### 5.4 PolicyGate

PolicyGate remains host-owned and runs before side effects.

Order:

1. Tool registered and enabled.
2. Input schema validation.
3. Host policy decision.
4. Pending approval creation when required.
5. Approved replay re-enters policy with approved call ID.
6. Tool precondition and business-boundary checks.
7. Tool execution.
8. Lifecycle and audit recording.

This order preserves the current security behavior: invalid args do not create
approval records, observe mode blocks actions, and standalone plugin MCP
servers do not become approval owners.

For action tools, precondition checks must not perform the side effect. They
may make read-only validation calls only when the tool's own domain contract
allows it and the result is auditable.

### 5.5 Postgres Session State and Recoverability

Introduce a host-owned Postgres session state store as part of the first
implementation.

Required concepts:

- `sessionId`: conversation-level identity.
- `runId`: single agent run identity.
- `toolCallId`: individual tool invocation identity.
- `stateMarkers`: named facts or lifecycle milestones created by tool results.
- `guidance`: recoverable next-step instructions linked to a tool call.
- `auditEvents`: immutable evidence of decisions and outcomes.

The local JSONL audit log may remain as an export/debug surface, but Postgres
must become the source of truth for sessions, runs, messages, tool invocations,
guidance payloads, state markers, approvals, artifacts, and audit events.

Required state transitions:

- `run_started`
- `tool_requested`
- `policy_decision`
- `tool_guidance`
- `tool_result`
- `approval_pending`
- `approval_approved`
- `approval_denied`
- `state_marker_recorded`
- `run_completed`

Postgres requirements:

- Persist sessions, runs, messages, tool invocations, approvals, audit events,
  artifacts, guidance payloads, and state markers.
- Restore a session without trusting frontend memory.
- Resume approval decisions after server restart.
- Reconstruct the model-visible conversation state from stored messages and
  selected tool results.
- Preserve immutable audit events even when higher-level session summaries are
  updated.
- Provide a migration/init path for local development and tests.
- Keep database writes transactionally aligned for one tool invocation: policy
  decision, guidance/result, state markers, artifacts, and audit records should
  not become contradictory partial state.

### 5.6 Model Feedback Loop

The runtime should feed structured recoverable outcomes back to the model as
tool results. The system prompt may mention that recoverable tool guidance is
authoritative and should be followed before retrying the blocked action.

The model should remain free to choose another investigative path when the
guidance is not relevant to the analyst's goal. Guidance is a correction vector,
not a hidden workflow.

### 5.7 Frontend and API

The web console should render recoverable guidance distinctly from hard
failures:

- pending approval: analyst decision needed
- denied: policy boundary
- failed: invalid or unrecoverable failure
- guidance: model can self-correct or analyst can inspect next suggested tool

The API should preserve existing consumers while exposing the structured
guidance in `invocation.result` or a future first-class field.

## 6. Acceptance Criteria

1. The model can still see and choose from the enabled tool surface instead of
   being forced through a preplanned workflow.
2. Invalid arguments still fail before policy and approval persistence.
3. Host policy still gates action tools before side effects.
4. Interface-local precondition mismatch returns structured, model-usable
   guidance instead of only an opaque error string.
5. Guidance outcomes are included in run events and audit records.
6. Wazuh and Shuffle plugins can add domain preconditions without importing
   host approval or UI modules.
7. Approval behavior remains compatible with existing tests: ask mode creates
   pending approval, deny consumes without side effect, approve executes once,
   and persisted approvals survive restart.
8. Postgres persists session/run/tool IDs, messages, approvals, state markers,
   guidance, artifacts, and audit events as the recoverable source of truth.
9. Frontend/API consumers can distinguish policy denial, pending approval,
   hard failure, and recoverable guidance.
10. A restarted server can restore a session and pending approvals from
    Postgres without relying on frontend memory or JSON approval files.

## 7. Implementation Slices

Recommended first implementation plan:

1. Shared contract slice:
   add `ToolGuidance`, lifecycle event types, and a helper for recoverable tool
   outcomes while preserving current API compatibility.
2. Registry/runtime slice:
   record guidance outcomes, emit audit events, and feed guidance back through
   AI SDK tool results.
3. Plugin precondition slice:
   add one Wazuh or Shuffle precondition as a proof point, such as Shuffle
   workflow execution requiring prior workflow metadata or explicit confirmed
   arguments.
4. Frontend/API slice:
   render recoverable guidance separately from hard errors.
5. Postgres storage slice:
   add the session-state abstraction and implement Postgres as the first
   durable backend, including local test migrations/init.
6. Recovery slice:
   restore sessions, runs, messages, guidance, approvals, artifacts, and audit
   events after restart, and keep JSONL only as a secondary local trace/export.

## 8. Verification Plan

Required automated verification:

- `npm run test -w apps/server`
- `npm run test -w plugins/wazuh-secops`
- `npm run test -w plugins/shuffle-secops`
- `npm run typecheck`

Focused test cases:

- recoverable guidance is returned to the model as a tool result
- guidance emits audit and run events
- invalid arguments do not create pending approvals
- observe mode still denies action tools
- ask-mode action still creates persisted pending approval
- approved replay executes once with the saved invocation ID
- plugin precondition can be tested without host approval-store imports
- Postgres stores and restores sessions, runs, messages, guidance, approvals,
  artifacts, state markers, and audit events
- restart recovery reads durable state from Postgres rather than frontend
  memory or JSON approval files
- one tool invocation cannot persist contradictory policy/result/audit state

Manual verification:

- Run the web console and confirm guidance, denial, failure, and pending
  approval render as distinct states.
- Confirm audit event details do not leak credentials or tokens.

Known sandbox note:

- Do not use sandboxed root/web Vite builds as completion evidence; existing
  project notes say those builds are not useful in this environment.

## 9. ADR Signal

This design changes durable architecture surfaces:

- shared public contract shape
- lifecycle event taxonomy
- host/plugin responsibility boundary
- Postgres source-of-truth boundary
- frontend interpretation of tool outcomes

After implementation, record an ADR or baseline update if the shared contract
or storage boundary is accepted.

## 10. Implementation Decision

Postgres is included in the first implementation scope. The implementation
plan should still sequence work so the lifecycle contract lands before the
storage adapter uses it, but completion is not sufficient until durable
Postgres session recovery is implemented and verified.
