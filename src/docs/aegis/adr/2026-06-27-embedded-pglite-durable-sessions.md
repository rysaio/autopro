# ADR: Embedded PGlite Durable Sessions

Date: 2026-06-27
Status: accepted

## Context
Previous Adr:
The 2026-06-19 ADR made Postgres the durable source of truth, reached through a
`SECOPS_DATABASE_URL` connection and a project-owned Docker Compose instance.
That coupled durable sessions to an external database and a Docker runtime: the
packaged executable had to detect Docker and start a container, and durable-store
tests required a live Postgres. For a single-operator, locally-run console this
operational weight was not justified. 

Now: consider a trans to pglite embedded-in, replace all PostgreSQL practice.
## Decision

Run durable sessions on an embedded PGlite store, in-process, with no external
database or Docker:

- The session/approval store keeps the same Postgres SQL schema and behaviour;
  only the engine changes (`@electric-sql/pglite` instead of the `pg` client).
- Durability is configured by `SECOPS_DATA_DIR` (default `runtime/pgdata`), with
  `memory://` for an ephemeral in-memory store.
- Durable sessions are on by default; `SECOPS_DURABLE_SESSIONS=off` disables them
  and falls back to the local JSON approval store + no-op session state.
- The control-boundary decisions from the 2026-06-19 ADR (host-owned PolicyGate,
  approval, audit, lifecycle, recoverable guidance) are unchanged.

## Consequences

- No Docker, Compose file, or external database is needed to run or test the app;
  `compose.yaml`, the `db:test:*` / `test:postgres` scripts, and the `pg` /
  `@types/pg` dependencies are removed.
- Durable-store tests run in-process against PGlite (`memory://` plus a
  `dumpDataDir`/`loadDataDir` snapshot to exercise the restart round-trip), so a
  real-database integration run is no longer a release gate.
- The packaged launchers no longer probe for Docker; `start.bat` boots with
  embedded durable sessions and `start-no-postgres.bat` disables them.

## Alternatives Considered

- Keep external Postgres: rejected — operational weight (Docker, container
  lifecycle, separate test DB) is disproportionate for a local single-operator
  console.
