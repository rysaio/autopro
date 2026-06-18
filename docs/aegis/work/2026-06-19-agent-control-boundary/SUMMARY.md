# Agent Control Boundary Summary

Date: 2026-06-19
Status: implementation slices complete; real Postgres and manual Web verification still required for final acceptance

## Implemented

- Added shared recoverable guidance contracts and optional `AgentRun.sessionId`.
- Added runtime/session state recording for runs, messages, tool invocations, guidance, artifacts, audit events, and state markers.
- Added Shuffle proof point: `shuffle.workflow.execute` returns guidance to call `shuffle.workflow.get` when workflow metadata state is missing.
- Added Postgres migrations and `PostgresSessionStore` for sessions, runs, messages, invocations, guidance, artifacts, audit events, state markers, and pending approvals.
- Wired Postgres-backed approvals and health reporting through the Fastify app when `SECOPS_DATABASE_URL` is configured.
- Added `GET /api/sessions` and `GET /api/sessions/:id` so the Web console can read durable session state from the server.
- Updated the Web console to list durable sessions and render recoverable guidance separately from hard failure, denial, and pending approval states.

## Boundary Decisions

- The model still sees the available tool surface and is not forced through a host-owned workflow graph.
- Host owns PolicyGate, approvals, audit, runtime lifecycle, API, UI integration, and Postgres source-of-truth state.
- Plugins own domain preconditions and return structured guidance for recoverable sequencing or context gaps.
- Local JSON approval/audit files remain a degraded development/export path only; Postgres is the recovery authority when configured.

## Verification

- `npm run test -w apps/server` -> passed, 44 tests passed and 4 Postgres tests skipped because `SECOPS_TEST_DATABASE_URL` was not configured.
- `npm run test -w plugins/shuffle-secops` -> passed, 18 tests passed.
- `npm run test -w plugins/wazuh-secops` -> passed, 20 tests passed.
- `npm run typecheck` -> passed across shared, Wazuh plugin, Shuffle plugin, server, and web.

## Unverified / Required Evidence

- Real Postgres integration remains required with `SECOPS_TEST_DATABASE_URL` to prove durable recovery against a live database.
- Manual Web console check remains required for distinct guidance, denied, failed, and pending approval rendering.
- Live Wazuh and Shuffle smoke checks still require real service credentials.

## Next Tasks

- Run the skipped Postgres integration suite with a real test database.
- Start the Web console and manually produce guidance, denial, hard failure, and pending approval states.
- Add a thin app-server Shuffle adapter only if the main console should expose Shuffle tools directly.
