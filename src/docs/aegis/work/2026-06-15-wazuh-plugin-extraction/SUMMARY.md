# Wazuh SecOps Plugin Extraction Summary

Date: 2026-06-15
Status: reusable package, MCP stdio, portable skills, read-only network/security operations tools, and lateral tools implemented; live Wazuh verification pending

## Implemented

- Created `plugins/wazuh-secops` as the repo-local plugin product boundary.
- Made `plugins/wazuh-secops` an npm workspace package named
  `@secops-agent/wazuh-secops`.
- Added reusable Wazuh core exports:
  - Wazuh Server API config and client.
  - Wazuh Indexer/OpenSearch config and alert search client.
  - Sanitized Wazuh config status helper.
- Added package core tests for:
  - missing config status
  - URL credential redaction/readiness reporting
  - Server API config parsing and credential-in-URL rejection
  - Indexer config parsing and credential-in-URL rejection
  - bounded alert search body construction
- Added portable Agent Skill folders:
  - `wazuh-linux-network-monitoring`
  - `wazuh-network-exposure-mapping`
  - `wazuh-alert-triage-threat-hunting`
  - `wazuh-lateral-movement-analysis`
  - `wazuh-active-response-operations`
- Added a Codex plugin manifest at
  `plugins/wazuh-secops/.codex-plugin/plugin.json`.
- Added `plugins/wazuh-secops/.mcp.json`.
- Added standalone MCP stdio support:
  - `plugins/wazuh-secops/src/adapters/mcpServer.ts`
  - `plugins/wazuh-secops/src/bin/wazuh-mcp.ts`
- Added standalone package smoke support:
  - `plugins/wazuh-secops/src/bin/wazuh-smoke.ts`
  - npm script `smoke:wazuh`
  - bin `wazuh-secops-smoke`
- Added `plugins/wazuh-secops/README.md` with environment, verification, reuse,
  and safety boundaries.
- Moved Wazuh tool manifests and handlers into the plugin package as
  host-neutral `WazuhPluginTool` exports.
- Exported `createWazuhTools` from `@secops-agent/wazuh-secops`.
- Added read-only lateral and network analysis tools:
  - `wazuh.network.exposure.map`
  - `wazuh.agent.alerts.timeline`
  - `wazuh.ip.activity.timeline`
  - `wazuh.rule.hits.summary`
  - `wazuh.network.service.find`
  - `wazuh.host.neighbors`
  - `wazuh.lateral.suspects`
  - `wazuh.lateral.path.summary`
- Exported reusable workflow helpers from the npm package:
  - `networkExposureMap`
  - `ruleHitsSummary`
  - `agentAlertTimeline`
  - `ipActivityTimeline`
  - `networkServiceFind`
  - `hostNeighbors`
  - `lateralSuspects`
  - `lateralPathSummary`
- Replaced `apps/server/src/tools/wazuhTools.ts` with a thin adapter from
  plugin tools to the server's existing `SecOpsTool` interface.
- Added `@secops-agent/wazuh-secops` as an app server dependency.
- Retired app-local Wazuh client/indexer/tool-helper owners:
  - `apps/server/src/integrations/wazuh/client.ts`
  - `apps/server/src/integrations/wazuh/indexerClient.ts`
  - `apps/server/src/tools/wazuhToolHelpers.ts`
- Kept `apps/server/src/integrations/wazuh/smoke.ts` as an app-specific smoke
  wrapper because it exercises the server `ToolRegistry` and approval behavior.
- Updated root npm workspaces to include `plugins/*`.
- Updated `package-lock.json` so `plugins/wazuh-secops` is tracked as a
  workspace.
- Updated `plugins/wazuh-secops/package.json` to be package-distribution
  shaped, with `files` covering `dist/`, `skills/`, `.mcp.json`,
  `.codex-plugin/`, and `README.md`.
- Added design and plan records:
  - `docs/aegis/specs/2026-06-15-wazuh-plugin-extraction-design.md`
  - `docs/aegis/plans/2026-06-15-wazuh-plugin-extraction.md`

## Research Notes

- Re-checked public Wazuh MCP/Agent Skill references during this slice; no
  mature directly reusable Wazuh MCP/Agent Skill package was identified.
- Continued implementation against primary contracts instead:
  - Wazuh Server API and syscollector inventory.
  - Wazuh Indexer/OpenSearch alert searches.
  - MCP stdio server packaging.
  - Open Agent Skills folder format.

## Verification Evidence

- `npm run test -w plugins/wazuh-secops`: passed, 1 file / 7 tests.
- `npm run build -w plugins/wazuh-secops`: passed.
- `npm run test -w apps/server`: passed, 16 files / 54 tests.
- `npm run typecheck`: passed.
- `npm run build -w apps/server`: passed.
- `node -e "JSON.parse(...plugin.json...)"`: passed for Codex manifest JSON
  syntax.
- After moving tool manifests/handlers into the plugin and adapting server:
  - `npm run test -w plugins/wazuh-secops`: passed, 2 files / 10 tests.
  - `npm run build -w plugins/wazuh-secops`: passed.
  - `npm run test -w apps/server`: passed, 16 files / 54 tests.
  - `npm run typecheck`: passed.
  - `npm run build -w apps/server`: passed.
- After adding MCP stdio:
  - `npm run test -w plugins/wazuh-secops`: passed, 3 files / 13 tests.
  - `npm run build -w plugins/wazuh-secops`: passed.
  - `npm run test -w apps/server`: passed, 16 files / 54 tests.
  - `npm run typecheck`: passed.
  - `npm run build -w apps/server`: passed.
  - JSON syntax check for `.codex-plugin/plugin.json` and `.mcp.json`: passed.
- After adding read-only lateral-analysis tools:
  - `npm run test -w plugins/wazuh-secops`: passed, 4 files / 17 tests.
  - `npm run build -w plugins/wazuh-secops`: passed.
  - `npm run test -w apps/server`: passed, 16 files / 54 tests.
  - `npm run typecheck`: passed.
  - `npm run build -w apps/server`: passed.
- After adding exposure/rule-hit tools and two more portable skills:
  - `npm run test -w plugins/wazuh-secops`: passed, 5 files / 19 tests.
  - `npm run build -w plugins/wazuh-secops`: passed.
  - `npm run test -w apps/server`: passed, 16 files / 54 tests.
  - `npm run typecheck`: passed.
  - `npm run build -w apps/server`: passed.
- After adding package smoke bin:
  - `npm run test -w plugins/wazuh-secops`: passed, 6 files / 20 tests.
  - `npm run build -w plugins/wazuh-secops`: passed.
  - `npm run smoke:wazuh -w plugins/wazuh-secops`: passed without live Wazuh
    env; reports config status and skipped API/Indexer/Active Response checks.
  - `npm run test -w apps/server`: passed, 16 files / 54 tests.
  - `npm run typecheck`: passed.
  - `npm run build -w apps/server`: passed.
  - `npm pack -w plugins/wazuh-secops --dry-run`: passed after sandbox
    escalation for npm cache writes; tarball includes `dist/`,
    `dist/bin/wazuh-smoke.js`, `skills/`, `.mcp.json`,
    `.codex-plugin/plugin.json`, `README.md`, and `package.json`.
  - JSON syntax check for `.codex-plugin/plugin.json`, `.mcp.json`, and
    `package.json`: passed.

## Validation Notes

- `python .../plugin-creator/scripts/validate_plugin.py plugins/wazuh-secops`
  could not run because the local Python environment is missing the `yaml`
  module. This is a host tooling gap, not a plugin manifest schema failure.
- Sandboxed root/web Vite builds were not run and remain documented as
  non-useful Wazuh verification unless sandbox permissions change.
- Test note for future agents: do not repeat sandboxed `npm run build` or
  `npm run build -w apps/web` for Wazuh/plugin verification. They fail in the
  sandbox due the known Vite config filesystem permission issue and do not add
  useful evidence for this package.

## External Verification Follow-Up

- Validate the Codex plugin manifest once plugin validation tooling can import
  its Python dependencies.
- Run real Wazuh API/Indexer smoke verification when a real environment is
  configured.
