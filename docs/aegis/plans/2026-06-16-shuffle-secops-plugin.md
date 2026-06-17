# Shuffle SecOps Plugin Plan

Goal: create `plugins/shuffle-secops` as a repo-local plugin folder that is
also a reusable npm package, MCP stdio server, CLI/smoke surface, Codex wrapper,
and portable Agent Skills pack for operating Shuffle SOAR from agentic hosts.

Architecture: plugin-folder-first, host-neutral design. The package owns
Shuffle REST clients, built-in Shuffle HTTP MCP forwarding helpers, tool
manifests, handlers, workflow helpers, MCP stdio entrypoint, Codex metadata,
and skills. Host applications own approval policy, audit, runtime, and UI.

Tech Stack: TypeScript ESM, Node.js `fetch`, `@modelcontextprotocol/sdk`, Zod,
Vitest, Shuffle REST API, Shuffle built-in HTTP MCP API where available.

Baseline/Authority Refs:

- `docs/architecture.md`
- `docs/aegis/specs/2026-06-15-wazuh-plugin-extraction-design.md`
- `docs/aegis/plans/2026-06-15-wazuh-plugin-extraction.md`
- `plugins/wazuh-secops`
- Shuffle API docs: `https://raw.githubusercontent.com/Shuffle/shuffle-docs/master/docs/API.md`
- Shuffle trigger docs: `https://raw.githubusercontent.com/Shuffle/shuffle-docs/master/docs/triggers.md`
- Wazuh external API integration docs for Shuffle webhook forwarding

Compatibility Boundary:

- Keep the finished artifact under `plugins/shuffle-secops`.
- Do not make Codex the canonical owner; Codex is only a wrapper.
- Prefer official Shuffle REST/OpenAPI and built-in HTTP MCP/Agent APIs over
  unmaintained third-party wrappers.
- Keep side-effecting tools action-classed and denied by standalone MCP unless
  explicitly enabled.
- Do not hard-code one webhook invocation URL shape because Shuffle docs show
  both `/webhooks/webhook_<uuid>` and `/hooks/<id>` variants across versions.
- Do not require a live Shuffle server for unit tests.
- Do not rerun sandboxed root/web Vite builds as verification.

Verification:

- `npm run test -w plugins/shuffle-secops`
- `npm run build -w plugins/shuffle-secops`
- `npm run smoke:shuffle -w plugins/shuffle-secops`
- `npm pack -w plugins/shuffle-secops --dry-run`
- Optional app integration later: `npm run test -w apps/server`,
  `npm run typecheck`, `npm run build -w apps/server`

## Architecture Integrity Lens

- Invariant: Shuffle domain behavior has one canonical owner.
- Canonical owner: `plugins/shuffle-secops`.
- Host owner: app/runtime hosts own approval, audit, UI, and policy.
- Responsibility overlap: none today because no app-local Shuffle owner exists.
- Higher-level simplification: package exports host-neutral tools and an MCP
  server; skills reuse those tools without duplicating logic.
- Retirement trigger: if app-local Shuffle wrappers are added later, they must
  be thin adapters around this package.
- Verdict: proceed with standalone plugin package first.

## Plan-Time Complexity Check

- Target files: new `plugins/shuffle-secops/*`, root package scripts/lockfile,
  docs index.
- Existing size / shape signals: Wazuh plugin provides a stable package shape;
  no large existing Shuffle file to deepen.
- Owner fit: new package is the correct owner.
- Add-in-place risk: low if the first slice stays standalone.
- Better file boundary: `core/`, `tools/`, `adapters/`, `bin/`, `skills/`,
  `test/`.
- Recommendation: add owner package and keep server integration optional.

## Task 1: Research-Bound Package Scaffold

Files:

- `plugins/shuffle-secops/package.json`
- `plugins/shuffle-secops/tsconfig.json`
- `plugins/shuffle-secops/README.md`
- `plugins/shuffle-secops/src/index.ts`
- `plugins/shuffle-secops/src/core/configStatus.ts`
- `plugins/shuffle-secops/src/core/shuffleClient.ts`
- `plugins/shuffle-secops/test/core.test.ts`

Why: establish a reusable Shuffle package owner with official API-based
configuration and sanitized readiness.

Verification:

- `npm run test -w plugins/shuffle-secops`
- `npm run build -w plugins/shuffle-secops`

Steps:

1. Write tests for missing config, URL credential rejection, org header use,
   and secret redaction.
2. Implement env config and REST request helper.
3. Export package core from `src/index.ts`.
4. Run package tests and build.

## Task 2: Tool Registry and REST Operations

Files:

- `plugins/shuffle-secops/src/tools/types.ts`
- `plugins/shuffle-secops/src/tools/helpers.ts`
- `plugins/shuffle-secops/src/tools/registry.ts`
- `plugins/shuffle-secops/test/tools.test.ts`

Why: expose agent-usable Shuffle operations without coupling to one host.

Initial tools:

- `shuffle.config.status`
- `shuffle.health`
- `shuffle.workflows.list`
- `shuffle.workflow.get`
- `shuffle.workflow.execute`
- `shuffle.workflow.executions.list`
- `shuffle.execution.result.get`
- `shuffle.apps.list`
- `shuffle.webhook.trigger`
- `shuffle.wazuh.alert.forward`
- `shuffle.mcp.call`

Verification:

- Fake Shuffle server tests prove headers, paths, bounds, action gating metadata,
  JSON string parsing, and sanitized outputs.
- `npm run test -w plugins/shuffle-secops`

## Task 3: MCP Stdio, CLI Smoke, and Metadata

Files:

- `plugins/shuffle-secops/src/adapters/mcpServer.ts`
- `plugins/shuffle-secops/src/bin/shuffle-mcp.ts`
- `plugins/shuffle-secops/src/bin/shuffle-smoke.ts`
- `plugins/shuffle-secops/.mcp.json`
- `plugins/shuffle-secops/.codex-plugin/plugin.json`

Why: make the same capability usable from generic MCP hosts and Codex.

Verification:

- `npm run test -w plugins/shuffle-secops`
- `npm run build -w plugins/shuffle-secops`
- `npm run smoke:shuffle -w plugins/shuffle-secops`

## Task 4: Portable Agent Skills

Files:

- `plugins/shuffle-secops/skills/shuffle-workflow-operations/SKILL.md`
- `plugins/shuffle-secops/skills/shuffle-wazuh-alert-automation/SKILL.md`
- `plugins/shuffle-secops/skills/shuffle-mcp-bridge/SKILL.md`

Why: let Codex, Claude Code, and other skills-aware hosts operate Shuffle
workflows, Wazuh alert automation, and Shuffle's built-in MCP layer safely.

Verification:

- Manual read-through for trigger clarity, no credential leakage, correct tool
  names, and approval-respecting action language.

## Task 5: Workspace Packaging

Files:

- root `package.json`
- root `package-lock.json`
- `docs/aegis/INDEX.md`

Why: include the plugin in workspace build/test/typecheck and durable plan index.

Verification:

- `npm run test -w plugins/shuffle-secops`
- `npm run build -w plugins/shuffle-secops`
- `npm pack -w plugins/shuffle-secops --dry-run`

## Risks and Residual Gates

- Live Shuffle verification needs `SHUFFLE_API_URL` and `SHUFFLE_API_KEY`.
- Webhook invocation URL shapes differ by Shuffle version; expose an explicit
  webhook URL tool instead of inventing a universal URL.
- Shuffle built-in HTTP MCP exists only on newer versions; `shuffle.mcp.call`
  must fail clearly on older servers.
- `shuffle.workflow.execute`, webhook forwarding, and MCP tool calls can trigger
  workflow side effects and must remain action-classed.

## Repair and Retirement Tracks

Repair Track:

- Repair object: missing Shuffle canonical plugin owner.
- Action: create `plugins/shuffle-secops`.
- Impact: model hosts can operate Shuffle through a reusable package/MCP/skills
  surface and coordinate with Wazuh alert forwarding.
- Verification: package tests, build, smoke, pack dry run.

Retirement Track:

- Old owner: none.
- Action: no deletion.
- Retained boundary: future app integrations must adapt this package rather
  than duplicate Shuffle domain logic.
- Future trigger: retire any app-local duplicate if one appears.
