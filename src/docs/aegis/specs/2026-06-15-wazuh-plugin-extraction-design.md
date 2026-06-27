# Wazuh SecOps Plugin Extraction Design

Date: 2026-06-15
Status: design pending review
ArchitectureReviewRequired: yes

## 1. Goal

Extract the existing Wazuh MCP tool work into one repo-local plugin directory
that is also a reusable Wazuh SecOps npm package plus portable Agent Skills.
Codex plugin support is only a thin wrapper around the package and skills,
while Claude Code and other agentic hosts can reuse the same skills directory
or MCP stdio entrypoint.

The plugin must let an agent monitor and operate Linux hosts managed by Wazuh
using Wazuh Server API and Wazuh Indexer/OpenSearch data, with explicit support
for internal-network monitoring, security operations, and lateral-movement
analysis workflows.

## 2. Baseline and Sources

Project authority:

- `docs/aegis/specs/2026-06-15-wazuh-mcp-tools-brief.md`
- `docs/aegis/work/2026-06-15-wazuh-mcp-tools/SUMMARY.md`
- `docs/architecture.md`
- Existing Wazuh implementation under `apps/server/src/integrations/wazuh/`
  and `apps/server/src/tools/wazuhTools.ts`

External references checked:

- [Wazuh API reference](https://documentation.wazuh.com/current/user-manual/api/reference.html)
- [Wazuh system inventory](https://documentation.wazuh.com/current/user-manual/capabilities/system-inventory/index.html)
- [Model Context Protocol: Build an MCP server](https://modelcontextprotocol.io/docs/develop/build-server)
- [Agent Skills overview](https://agentskills.io/)

Research finding:

- No mature, directly reusable Wazuh MCP/Agent Skill package was found during
  the current search. The design should therefore reuse official Wazuh API and
  Indexer contracts, MCP host portability patterns, and the open Agent Skills
  folder format rather than copying a third-party Wazuh plugin.

## 3. Non-Goals

- Do not use endpoint shell commands or `full_access.exec` to inspect Linux
  hosts.
- Do not make a Codex-only plugin that cannot be reused by Claude Code or other
  MCP/skills-compatible hosts.
- Do not make the reusable capability depend on Codex-only plugin packaging.
  Codex support is a wrapper, not the canonical runtime owner.
- Do not scatter the repo-local product across unrelated directories. The
  finished artifact in this repo must live under one manageable plugin folder.
- Do not add generic unrestricted Active Response execution in the first
  extraction slice.
- Do not require a real Wazuh environment for unit tests; live Wazuh remains a
  separate smoke/manual verification gate.
- Do not repeat sandboxed root/web Vite builds as Wazuh verification.

## 4. Compatibility Boundary

The current SecOps app must keep the existing tool manifest IDs and API names
unless a migration is explicitly planned:

- `wazuh.config.status`
- `wazuh.health`
- `wazuh.agents.list`
- `wazuh.agent.get`
- `wazuh.agent.netaddr.list`
- `wazuh.agent.netiface.list`
- `wazuh.agent.ports.list`
- `wazuh.agent.processes.list`
- `wazuh.agent.network.summary`
- `wazuh.alerts.search`
- `wazuh.block_ip`

Existing approval behavior must also hold:

- Read-only tools execute without approval when enabled.
- `wazuh.block_ip` is denied in `observe`.
- `wazuh.block_ip` creates a pending approval in sandbox ask mode.
- `wazuh.block_ip` only executes automatically under full-access host policy.
- The AI SDK adapter must not become the approval owner.

## 5. Recommended Architecture

Use one plugin folder that also acts as the npm package and distribution root:

```text
plugins/wazuh-secops/
  .codex-plugin/
    plugin.json
  .mcp.json
  package.json
  tsconfig.json
  src/
    index.ts
    core/
      config.ts
      wazuhClient.ts
      indexerClient.ts
      schemas.ts
      artifacts.ts
      analysis.ts
    tools/
      manifests.ts
      handlers.ts
      registry.ts
    workflows/
      linuxNetworkMonitoring.ts
      lateralMovement.ts
      activeResponse.ts
    adapters/
      secopsAgent.ts
      mcpServer.ts
    bin/
      wazuh-mcp.ts
  skills/
    wazuh-linux-network-monitoring/SKILL.md
    wazuh-lateral-movement-analysis/SKILL.md
    wazuh-active-response-operations/SKILL.md
  README.md
```

This keeps the reusable runtime independent from any one host while keeping the
repo-local product in one folder. Codex uses `.codex-plugin/plugin.json` and
`.mcp.json`; Claude Code and other hosts can reuse `skills/` and the package
MCP stdio entrypoint.

## 6. Host Contracts

The reusable package should export host-neutral contracts:

```ts
export interface WazuhPluginTool {
  apiName: string;
  manifest: WazuhToolManifest;
  execute(args: Record<string, unknown>, context: WazuhExecutionContext): Promise<WazuhExecutionResult>;
}
```

Host adapters translate this into local host formats:

- SecOps app adapter: maps `WazuhPluginTool` to `SecOpsTool`.
- MCP adapter: registers tools/resources/prompts using the official MCP SDK.
- Agent Skills adapter: ships `SKILL.md` folders with workflow instructions
  that call the exposed MCP tools.
- Codex plugin manifest: points Codex at the same MCP server and skills.
- Claude Code reuse: copy or install the skill folders and configure the MCP
  stdio command.

## 7. Tool Expansion

Keep the current v0 tools and add tool groups that support network operations
and lateral analysis:

Network monitoring:

- `wazuh.agent.network.summary`: current combined syscollector view.
- `wazuh.network.exposure.map`: group agents by subnets, listening ports,
  bound addresses, and exposed services.
- `wazuh.network.service.find`: find agents exposing a target port/service.

Security operations:

- `wazuh.alerts.search`: current bounded alert search.
- `wazuh.agent.alerts.timeline`: bounded per-agent alert timeline.
- `wazuh.ip.activity.timeline`: bounded source/destination IP alert timeline.
- `wazuh.rule.hits.summary`: summarize recent rule activity by rule id/level.

Lateral-movement analysis:

- `wazuh.lateral.suspects`: correlate internal source IPs, repeated auth
  failures, remote execution indicators, privilege escalation, and new service
  exposure.
- `wazuh.lateral.path.summary`: summarize likely source -> target movement
  paths using alerts plus syscollector network inventory.
- `wazuh.host.neighbors`: show agents sharing subnets or touching each other in
  alerts.

Actions:

- `wazuh.block_ip`: retain current allowlisted Active Response action.
- Future actions must be explicit, allowlisted, reason-required, duration-bound,
  and approval-owned by the host.

## 8. Skills To Ship

`wazuh-linux-network-monitoring`

- Trigger: analyst asks to inspect Linux host network posture through Wazuh.
- Workflow: check config, list/choose agent, inspect interfaces/addresses,
  ports/processes, summarize exposure, recommend next read-only queries.
- Must not run endpoint shell commands.

`wazuh-lateral-movement-analysis`

- Trigger: analyst asks about internal movement, suspicious east-west traffic,
  compromised host pivoting, brute force, or service discovery.
- Workflow: establish time window, search alerts, map internal IPs to agents,
  correlate exposed services and related processes, output hypotheses and next
  evidence gaps.
- Must label correlation as evidence-backed or inferred.

`wazuh-active-response-operations`

- Trigger: analyst asks to block an IP or contain a Wazuh-observed threat.
- Workflow: verify target IP, list affected agents, check recent alert context,
  require reason/duration, use `wazuh.block_ip`, and respect host approval.
- Must never bypass host approval or issue generic Active Response commands.

## 9. Design Options Considered

Option A: Keep Wazuh code inside `apps/server`

- Pros: smallest immediate diff.
- Cons: cannot satisfy reusable plugin requirement; app remains the only owner.
- Decision: reject.

Option B: Codex-only plugin scaffold

- Pros: quick Codex installation path.
- Cons: weak reuse for Claude Code and other MCP hosts; risks duplicating logic
  between plugin and app.
- Decision: reject as primary path, keep as wrapper.

Option C: Host-neutral npm package inside one plugin folder plus thin adapters

- Pros: one canonical Wazuh owner, reusable by the current app, MCP hosts,
  Codex plugin wrapper, Claude Code, and Agent Skills-compatible clients while
  staying under one repo-local plugin folder.
- Cons: larger extraction, needs adapter tests.
- Decision: recommended.

## 10. Implementation Slices

Slice 1: Package extraction

- Create `plugins/wazuh-secops` as both npm package and plugin folder.
- Move Wazuh config, Server API client, Indexer client, manifests, handlers,
  artifact helpers, and smoke helpers into the package.
- Keep current server behavior by replacing internal imports with package
  imports through `adapters/secopsAgent`.

Slice 2: Portable skills

- Add three Agent Skill folders under the package.
- Add Codex plugin wrapper only after the package and skills are stable.
- Document Claude Code and generic MCP host installation.

Slice 3: Lateral analysis read-only tools

- Add alert timeline, IP activity timeline, host neighbors, service finder, and
  lateral suspect/path summary tools.
- Prefer bounded Wazuh Indexer/OpenSearch searches and Wazuh syscollector data.

Slice 4: Standalone MCP adapter

- Add an MCP stdio entrypoint backed by the package registry.
- Ensure stdio logging does not write to stdout.
- Expose prompts/resources for the three skills where useful.

Slice 5: Live verification

- Use fake Wazuh and fake Indexer tests for CI.
- Use `npm run smoke:wazuh -w apps/server` or the package smoke runner for a
  real Wazuh environment.
- Real environment verification requires `WAZUH_API_*`, `WAZUH_INDEXER_*`, and
  at least one Linux agent id.

## 11. Verification Plan

Sandbox-safe verification:

- `npm run test -w plugins/wazuh-secops`
- `npm run test -w apps/server`
- `npm run typecheck`
- `npm run build -w plugins/wazuh-secops`
- `npm run build -w apps/server`

Do not use sandboxed `npm run build` or `npm run build -w apps/web` as Wazuh
verification unless sandbox permissions change.

Live verification:

- `npm run smoke:wazuh -w plugins/wazuh-secops`
- `npm run smoke:wazuh -w apps/server`
- Manual MCP client discovery/call against the standalone plugin MCP server.

## 12. TaskIntentDraft

Outcome:

- A reusable Wazuh SecOps plugin folder that is also an npm package and
  portable skill pack, not an app-local tool bundle.

Success evidence:

- Current app still exposes the existing Wazuh tools.
- A standalone package exports Wazuh tools and skills without importing
  `apps/server`.
- Tests prove fake Wazuh/fake Indexer behavior and host adapter behavior.
- A real Wazuh smoke path exists and reports missing config safely when not
  configured.

Stop condition:

- Stop before implementation until this design is reviewed.

Non-goals:

- No endpoint shell execution.
- No unrestricted Active Response.
- No Codex-only coupling.

## 13. ImpactStatementDraft

Affected owners:

- New canonical owner: `plugins/wazuh-secops`.
- Retained host owner: `apps/server` owns runtime, approval store, audit, web,
  and app-specific MCP endpoint.
- Retired owner: Wazuh domain logic should no longer be owned by
  `apps/server/src/tools/wazuhTools.ts` after extraction.

Architecture risk:

- Duplicated tool manifests between app and plugin.
- Approval ownership accidentally moving into package logic.
- Credentials or tokens leaking through generic MCP/package outputs.
- Lateral analysis tools over-claiming inference as evidence.

Mitigation:

- Package owns domain manifests and handlers.
- Host owns policy, approval, audit, and enabled-tool filtering.
- Tests check manifest parity, approval behavior, and secret redaction.
- Skill instructions require labeling inference vs direct evidence.

## 14. Review Gate

This design requires review before implementation because it creates a new
public package owner, host adapter contract, skill distribution boundary, and
future plugin install shape.
