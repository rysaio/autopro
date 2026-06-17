# Wazuh SecOps Plugin Extraction Plan

Goal: extract Wazuh tools and skills into `plugins/wazuh-secops` as one
repo-local plugin folder that is also the canonical reusable npm package owner,
then adapt the current SecOps server to consume that package without changing
existing Wazuh tool IDs or approval behavior.

Architecture: plugin-folder-first, host-adapter design. `plugins/wazuh-secops`
owns the npm package, Wazuh API clients, Indexer client, tool manifests,
handlers, workflow helpers, smoke runner, MCP stdio entrypoint, Codex plugin
metadata, and portable Agent Skills. The current server owns runtime policy,
approval, audit, web API, and its app-specific MCP facade.

Tech Stack: TypeScript ESM, Node.js built-ins for HTTP(S), Zod-compatible JSON
schemas via existing manifest shape, `@modelcontextprotocol/sdk` for MCP
adapter, Vitest for fake Wazuh/Indexer tests.

Baseline/Authority Refs:

- `docs/aegis/specs/2026-06-15-wazuh-mcp-tools-brief.md`
- `docs/aegis/specs/2026-06-15-wazuh-plugin-extraction-design.md`
- `docs/aegis/work/2026-06-15-wazuh-mcp-tools/SUMMARY.md`
- `docs/architecture.md`

Compatibility Boundary:

- Preserve all current Wazuh manifest IDs and model API names.
- Preserve current read/action policy behavior.
- Do not move approval ownership into the plugin package.
- Keep the repo-local product under `plugins/wazuh-secops` for management.
- Do not execute endpoint shell commands for Linux host monitoring.
- Do not rerun sandboxed root/web Vite builds as Wazuh verification.

Verification:

- `npm run test -w plugins/wazuh-secops`
- `npm run build -w plugins/wazuh-secops`
- `npm run test -w apps/server`
- `npm run typecheck`
- `npm run build -w apps/server`
- `npm run smoke:wazuh -w plugins/wazuh-secops` should fail safely without
  real env and print no credentials/tokens.

## Architecture Integrity Lens

- Invariant: Wazuh domain logic has one canonical owner.
- Canonical owner: `plugins/wazuh-secops`.
- Host owner: `apps/server` owns policy, approval, audit, UI, and app MCP.
- Responsibility overlap: current `apps/server/src/tools/wazuhTools.ts` and
  `apps/server/src/integrations/wazuh/*` temporarily remain until replaced by
  package imports.
- Higher-level simplification: package exports host-neutral tools; server only
  adapts them to `SecOpsTool`.
- Retirement trigger: after adapter parity tests pass, retire app-local Wazuh
  clients/handlers.
- Verdict: proceed with package extraction before new lateral-analysis tools.

## Plan-Time Complexity Check

- Target files: existing `apps/server/src/tools/wazuhTools.ts`,
  `apps/server/src/integrations/wazuh/*`, new `plugins/wazuh-secops/*`.
- Existing pressure: `wazuhTools.ts` is already large and owns domain logic plus
  server-specific adapter logic.
- Owner fit: new package is the correct owner for Wazuh domain behavior.
- Add-in-place risk: adding lateral analysis in `apps/server` would deepen the
  wrong owner.
- Better boundary: package `core/`, `tools/`, `workflows/`, and `adapters/`.
- Recommendation: extract owner first, then add new tools.

## Task 1: Scaffold Plugin Package and Move Wazuh Core

Files:

- Create `plugins/wazuh-secops/package.json`
- Create `plugins/wazuh-secops/tsconfig.json`
- Create `plugins/wazuh-secops/src/core/wazuhClient.ts`
- Create `plugins/wazuh-secops/src/core/indexerClient.ts`
- Create `plugins/wazuh-secops/src/core/configStatus.ts`
- Create `plugins/wazuh-secops/src/index.ts`
- Create `plugins/wazuh-secops/test/core.test.ts`

Why: establish the reusable plugin package owner without server imports.

Verification:

- `npm run build -w plugins/wazuh-secops`
- `npm run test -w plugins/wazuh-secops`

Steps:

1. Write tests for config parsing, missing env errors, no credentials in URLs,
   alert query body, and sanitized config status.
2. Run package tests and confirm they fail before implementation.
3. Copy existing Wazuh Server API and Indexer client logic into package core.
4. Export core clients and config helpers from `src/index.ts`.
5. Run package build and tests.

## Task 2: Extract Tool Manifests and Handlers

Files:

- Create `plugins/wazuh-secops/src/tools/types.ts`
- Create `plugins/wazuh-secops/src/tools/artifacts.ts`
- Create `plugins/wazuh-secops/src/tools/helpers.ts`
- Create `plugins/wazuh-secops/src/tools/manifests.ts`
- Create `plugins/wazuh-secops/src/tools/handlers.ts`
- Create `plugins/wazuh-secops/src/tools/registry.ts`
- Create `plugins/wazuh-secops/test/tools.test.ts`

Why: move Wazuh domain behavior out of `apps/server`.

Verification:

- `npm run test -w plugins/wazuh-secops`
- `npm run build -w plugins/wazuh-secops`

Steps:

1. Write parity tests for every current Wazuh manifest ID and API name.
2. Write fake Wazuh/Indexer handler tests for health, agents, syscollector,
   network summary, alert search, and block IP validation.
3. Implement host-neutral tool result and context types.
4. Move helpers and handlers from app-local Wazuh files into package tools.
5. Run package tests and build.

## Task 3: Adapt Current Server to Package

Files:

- Create `plugins/wazuh-secops/src/adapters/secopsAgent.ts`
- Modify `apps/server/src/tools/wazuhTools.ts`
- Modify `apps/server/src/skills/catalog.ts` if pack metadata moves.
- Modify server tests only where imports need package paths.

Why: prove the package can power the existing app without changing behavior.

Verification:

- `npm run test -w apps/server`
- `npm run typecheck`
- `npm run build -w apps/server`

Steps:

1. Add server adapter tests proving package tools map to `SecOpsTool`.
2. Replace app-local Wazuh implementation with adapter import.
3. Keep existing API names, manifest IDs, and approval behavior unchanged.
4. Retire app-local Wazuh clients/handlers once imports are gone.
5. Run server tests, root typecheck, and server build.

## Task 4: Add Portable Agent Skills and Package README

Files:

- Create `plugins/wazuh-secops/skills/wazuh-linux-network-monitoring/SKILL.md`
- Create `plugins/wazuh-secops/skills/wazuh-lateral-movement-analysis/SKILL.md`
- Create `plugins/wazuh-secops/skills/wazuh-active-response-operations/SKILL.md`
- Create `plugins/wazuh-secops/README.md`

Why: make the capability reusable by Codex, Claude Code, and other
skills-aware hosts.

Verification:

- Manual read-through for trigger clarity, no shell fallback, no approval
  bypass, and correct tool names.
- `npm run build -w plugins/wazuh-secops`

Steps:

1. Write Linux network monitoring skill with Wazuh-only tool flow.
2. Write lateral movement analysis skill with evidence vs inference rules.
3. Write active response operations skill with approval and duration/reason
   constraints.
4. Document Codex, Claude Code, generic MCP, and app embedding paths.
5. Run package build.

## Task 5: Add Read-Only Lateral Analysis Tools

Files:

- Modify `plugins/wazuh-secops/src/workflows/lateralMovement.ts`
- Modify `plugins/wazuh-secops/src/tools/manifests.ts`
- Modify `plugins/wazuh-secops/src/tools/handlers.ts`
- Add tests in `plugins/wazuh-secops/test/lateralMovement.test.ts`
- Add server adapter/catalog tests for new tools.

Why: expand from raw Wazuh views to network and lateral-movement operations.

Verification:

- `npm run test -w plugins/wazuh-secops`
- `npm run test -w apps/server`
- `npm run typecheck`
- `npm run build -w apps/server`

Steps:

1. Write tests for service finder, agent alert timeline, IP activity timeline,
   host neighbors, lateral suspects, and lateral path summary.
2. Implement bounded Indexer queries and syscollector correlation.
3. Label direct evidence vs inferred relationships in outputs.
4. Expose tools through package registry and server adapter.
5. Run package and server verification.

## Task 6: Add MCP Stdio Entrypoint and Codex Metadata

Files:

- Create `plugins/wazuh-secops/src/adapters/mcpServer.ts`
- Create `plugins/wazuh-secops/src/bin/wazuh-mcp.ts`
- Create `plugins/wazuh-secops/.codex-plugin/plugin.json`
- Create `plugins/wazuh-secops/.mcp.json`
- Update `plugins/wazuh-secops/README.md`

Why: make the same plugin folder directly usable by MCP hosts and easy to
install as a Codex plugin.

Verification:

- Package build succeeds.
- MCP client can discover Wazuh tools using fake config where possible.
- Codex plugin manifest validates with plugin validation tooling when available.

Steps:

1. Implement stdio MCP server using package tool registry.
2. Ensure logs do not write protocol noise to stdout.
3. Add Codex metadata pointing to the package MCP command and skills.
4. Validate plugin manifest.
5. Document install/reuse path.

## Risks and Residual Gates

- Real Wazuh API and Indexer verification remains external-env gated.
- Codex plugin validation may need local Codex plugin tooling outside package
  tests.
- Lateral movement tools can only provide correlations and hypotheses unless
  Wazuh alert content directly proves a path.

## Repair and Retirement Tracks

Repair Track:

- Repair object: Wazuh domain ownership.
- Action: extract into `plugins/wazuh-secops`.
- Impact: current app becomes one host adapter instead of the domain owner.
- Verification: package tests, server tests, typecheck, server build.

Retirement Track:

- Old owner: `apps/server/src/integrations/wazuh/*` and app-local Wazuh handler
  logic.
- Action: retire after adapter parity tests pass.
- Retained boundary: server keeps approval/audit/runtime ownership.
- Future trigger: delete app-local Wazuh implementation once no imports remain.
