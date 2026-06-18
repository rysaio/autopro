# ADR: Agent Control Boundary and Durable Session State

Date: 2026-06-19
Status: accepted

## Context

The SecOps Agent Console should trust the model to explore available tools
while controlling the business, policy, safety, and persistence boundary at
each interface. Previous behavior could only express many wrong-order calls as
ordinary failures, and session recovery depended on local runtime/UI state or
JSON traces rather than a durable session source of truth.

## Decision

Adopt a host-owned lifecycle and storage boundary:

- The model receives the available tool surface and chooses calls flexibly.
- The host owns PolicyGate, approval, audit, runtime lifecycle, API, UI
  integration, and durable session persistence.
- Each tool/interface owns its business preconditions and may return structured
  recoverable guidance when context or state is missing.
- Postgres is the durable source of truth for sessions, runs, messages, tool
  invocations, recoverable guidance, artifacts, state markers, pending
  approvals, and audit events when `SECOPS_DATABASE_URL` is configured.
- Local JSON approval and audit files remain only as degraded development or
  export traces, not recovery authority.

## Consequences

- Plugins can guide model self-correction without importing host approval,
  audit, UI, or database code.
- The Web console renders guidance as a recoverable state instead of a hard
  error.
- Session list/detail APIs read from server-owned durable state.
- Completion evidence must include a real Postgres integration run; skipped
  database tests are not sufficient proof of durable recovery.

## Alternatives Considered

- Host-owned workflow graph before model execution: rejected because it would
  reduce flexible model exploration and duplicate domain sequencing knowledge.
- Frontend/session memory as recovery source: rejected because it cannot prove
  restart recovery or auditable source-of-truth state.
- JSON files as authoritative approval/session storage: retained only for
  degraded local compatibility because they are not the intended durable
  recovery model.

## Verification

- Automated server, plugin, and typecheck suites passed on 2026-06-19.
- Real Postgres integration and manual Web rendering checks remain required
  before claiming final acceptance of the full control-boundary goal.
