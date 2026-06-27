# Wazuh MCP Tools Summary

Date: 2026-06-15
Status: implemented against fake Wazuh API; real Wazuh manual verification pending

Implemented the first Wazuh Server API integration slice as a first-class
SecOps skill/MCP tool pack.

Current verified surfaces:

- `secops-wazuh` is registered in the skill catalog and exposed through the
  existing web and MCP facades.
- `wazuh.config.status` reports sanitized Wazuh Server API, Wazuh Indexer, and
  smoke-test configuration readiness without exposing passwords or tokens.
- `wazuh.health`, `wazuh.agents.list`, `wazuh.agent.get`, and `wazuh.block_ip`
  are backed by typed manifests rather than capability prose.
- `wazuh.agent.netaddr.list`, `wazuh.agent.netiface.list`,
  `wazuh.agent.ports.list`, and `wazuh.agent.processes.list` expose Wazuh
  syscollector network and process inventory for explicit Linux agent ids.
- `wazuh.agent.network.summary` provides a combined Linux network monitoring
  view for one explicit Wazuh agent from syscollector interfaces, addresses,
  listening/open ports, and related processes.
- `wazuh.alerts.search` searches recent alerts through Wazuh
  Indexer/OpenSearch using bounded `_search` requests by source IP, agent id,
  rule id, time window, and limit.
- Wazuh API auth uses `/security/user/authenticate?raw=true`, caches the JWT in
  memory, and sends Bearer auth for API calls.
- Wazuh Indexer search uses Basic auth against `WAZUH_INDEXER_URL`, keeps
  credentials out of tool results, and fails explicitly when Indexer
  configuration is missing.
- Missing Wazuh configuration fails explicitly.
- Agent inventory tools return structured runtime artifacts.
- Syscollector network monitoring tools return structured runtime artifacts
  without endpoint shell execution.
- `wazuh.block_ip` validates IP, explicit agent ids, allowlisted command,
  bounded duration, and reason before calling `/active-response`.
- `wazuh.block_ip` is denied in `observe`, creates pending approval in sandbox
  ask mode, and executes in `full-access`.
- The implementation uses typed Wazuh API calls, not `full_access.exec` or shell
  fallbacks.
- AgentRuntime tests prove the model/tool loop can invoke Wazuh syscollector
  tools and can turn a Wazuh IP block request into a persisted pending approval.
- AgentRuntime tests prove the model/tool loop can invoke
  `wazuh.agent.network.summary` for internal network monitoring without
  endpoint shell execution.
- AgentRuntime tests prove the model/tool loop can invoke `wazuh.config.status`
  before live verification and receive sanitized readiness data.
- AgentRuntime tests also prove the model/tool loop can invoke
  `wazuh.alerts.search` through the Wazuh Indexer client and return sanitized
  runtime artifacts.
- `/api/skills` and `/api/tools` tests prove the web console catalog endpoints
  expose `secops-wazuh` and its executable Wazuh tools.
- AI SDK `needsApproval` is disabled at the tool adapter boundary so approval
  remains owned by `ToolRegistry` and the project approval store.
- `npm run smoke:wazuh -w apps/server` provides a real Wazuh smoke path that
  does not print credentials or tokens. It starts with `wazuh.config.status`,
  verifies Server API/syscollector checks, verifies
  `wazuh.agent.network.summary`, verifies Indexer alert search when Indexer
  variables are configured, and by default stops block checks at sandbox
  pending approval without executing Active Response.
- Streamable HTTP MCP tests prove a real MCP client can discover Wazuh tools,
  call `wazuh.agent.ports.list`, and request `wazuh.block_ip` without bypassing
  approval.
- README and `.env.example` document Wazuh Server API, Wazuh Indexer, and
  manual checks.
- README and the Wazuh spec testing notes document that sandboxed root/web
  Vite builds are not useful verification signals because they fail on local
  filesystem sandbox permissions.

Verification evidence:

- `npm run test -w apps/server`: passed.
- `npm run typecheck`: passed.
- `npm test`: passed.
- `npm run build -w apps/server`: passed after adding syscollector tools.
- `npm run test -w apps/server`: passed after adding AgentRuntime and smoke
  runner coverage.
- `npm run typecheck`: passed after adding smoke runner coverage.
- `npm run build -w apps/server`: passed after adding smoke runner coverage.
- `npm run test -w apps/server -- streamableMcp.test.ts`: passed after adding
  Streamable MCP Wazuh discovery/call coverage.
- `npm run test -w apps/server`: passed after adding Streamable MCP Wazuh
  coverage.
- `npm run typecheck`: passed after adding Streamable MCP Wazuh coverage.
- `npm run build -w apps/server`: passed after adding Streamable MCP Wazuh
  coverage.
- `npm run test -w apps/server -- wazuhAlerts.test.ts registry.test.ts mcp.test.ts`:
  passed after adding Wazuh Indexer alert search.
- `npm run test -w apps/server`: passed after adding Wazuh Indexer alert
  search.
- `npm run typecheck`: passed after adding Wazuh Indexer alert search.
- `npm run build -w apps/server`: passed after adding Wazuh Indexer alert
  search.
- `npm run test -w apps/server -- wazuhSmoke.test.ts wazuhAlerts.test.ts`:
  passed after adding Indexer alert search to the Wazuh smoke runner.
- `npm run test -w apps/server`: passed after adding Indexer alert search to
  the Wazuh smoke runner.
- `npm run typecheck`: passed after adding Indexer alert search to the Wazuh
  smoke runner.
- `npm run build -w apps/server`: passed after adding Indexer alert search to
  the Wazuh smoke runner.
- `npm run test -w apps/server -- agentRuntime.test.ts toolCatalogApi.test.ts`:
  passed after adding AgentRuntime alert search and web catalog API coverage.
- `npm run test -w apps/server`: passed after adding AgentRuntime alert search
  and web catalog API coverage.
- `npm run typecheck`: passed after adding AgentRuntime alert search and web
  catalog API coverage.
- `npm run build -w apps/server`: passed after adding AgentRuntime alert search
  and web catalog API coverage.
- `npm run test -w apps/server -- wazuhTools.test.ts agentRuntime.test.ts mcp.test.ts registry.test.ts toolCatalogApi.test.ts wazuhSmoke.test.ts streamableMcp.test.ts`:
  passed after adding `wazuh.agent.network.summary`.
- `npm run test -w apps/server`: passed after adding
  `wazuh.agent.network.summary`.
- `npm run typecheck`: passed after adding `wazuh.agent.network.summary`.
- `npm run build -w apps/server`: passed after adding
  `wazuh.agent.network.summary`.
- `npm run test -w apps/server -- wazuhTools.test.ts wazuhAlerts.test.ts agentRuntime.test.ts registry.test.ts mcp.test.ts toolCatalogApi.test.ts wazuhSmoke.test.ts streamableMcp.test.ts`:
  passed after extracting Wazuh tool helper functions.
- `npm run test -w apps/server`: passed after extracting Wazuh tool helper
  functions.
- `npm run typecheck`: passed after extracting Wazuh tool helper functions.
- `npm run build -w apps/server`: passed after extracting Wazuh tool helper
  functions.
- `npm run test -w apps/server -- wazuhTools.test.ts agentRuntime.test.ts registry.test.ts mcp.test.ts toolCatalogApi.test.ts wazuhSmoke.test.ts streamableMcp.test.ts`:
  passed after adding `wazuh.config.status`.
- `npm run test -w apps/server`: passed after adding `wazuh.config.status`.
- `npm run typecheck`: passed after adding `wazuh.config.status`.
- `npm run build -w apps/server`: passed after adding `wazuh.config.status`.
- `npm run build`: passed outside the filesystem sandbox.
- `npm run test -w apps/server -- wazuhSmoke.test.ts wazuhTools.test.ts`:
  passed after adding smoke config-status summaries.
- `npm run test -w apps/server`: passed on rerun after a prior transient
  Vitest worker fork exit; 16 files and 54 tests passed.
- `npm run typecheck`: passed after smoke config-status summaries and testing
  note documentation.
- `npm run build -w apps/server`: passed after smoke config-status summaries
  and testing note documentation.
- `npm run smoke:wazuh -w apps/server`: failed as expected without local real
  Wazuh configuration. The sanitized summary reported missing
  `WAZUH_API_URL`, `WAZUH_API_USER`, `WAZUH_API_PASSWORD`,
  `WAZUH_INDEXER_URL`, `WAZUH_INDEXER_USER`, `WAZUH_INDEXER_PASSWORD`, no
  smoke agent id, no alert filter, no block IP, and no credential/token output.

Testing notes:

- A sandboxed `npm run build` and `npm run build -w apps/web` failed at Vite
  config loading with `Cannot read directory "../../../..": Access is denied`
  and `Could not resolve ... apps/web/vite.config.ts`.
- The same web build and root build passed outside the sandbox. Treat this as a
  local sandbox permission limitation, not as a Wazuh code regression.
- Do not repeat the sandboxed Vite build as a useful verification step unless
  the sandbox permissions change.
- For repeatable sandbox verification, use `npm run typecheck`,
  `npm run test -w apps/server`, and `npm run build -w apps/server`.

Remaining product gaps:

- Manual verification against a real Wazuh API is still pending.
- Manual verification against a real Wazuh Indexer/OpenSearch deployment is
  still pending.
- Current local environment check showed `WAZUH_API_URL`, `WAZUH_API_USER`,
  `WAZUH_API_PASSWORD`, `WAZUH_SMOKE_AGENT_ID`, `WAZUH_INDEXER_URL`,
  `WAZUH_INDEXER_USER`, and `WAZUH_INDEXER_PASSWORD` are not configured.
- `apps/server/src/tools/wazuhTools.ts` crossed 800 lines after the network
  summary addition, then Wazuh parsing/summary helpers were extracted into
  `apps/server/src/tools/wazuhToolHelpers.ts`. `wazuhTools.ts` is now back
  under 800 lines; future Wazuh expansion may still warrant splitting
  manifests and handlers.
- Generic Active Response is intentionally deferred until `wazuh.block_ip` is
  stable in real use.
