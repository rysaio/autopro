# Wazuh MCP Tools Spec Brief

Date: 2026-06-15
Status: draft for implementation planning

## 1. Task Intent

Build a first-class Wazuh integration as a decoupled SecOps skill/MCP tool
pack. The agent should be able to query Wazuh state and perform explicit,
audited Wazuh actions such as endpoint-side IP blocking without falling back to
arbitrary shell execution.

Success evidence:

- The web console lists a `secops-wazuh` skill pack and its executable tools.
- MCP clients can discover and call the same Wazuh tools through the existing
  MCP transport.
- The agent can answer what Wazuh tools are available by using typed tool
  manifests rather than inventing capability text.
- Read-only Wazuh calls return structured artifacts and audit events.
- IP blocking runs through a typed Wazuh action tool, records target IP, target
  agents, command, reason, and Wazuh response, and respects the current access
  level.

Stop condition:

- Wazuh v0 tools are implemented, tested with a scripted HTTP client/fake Wazuh
  server, manually verified against configured API values when available, and
  documented in README.

## 2. Current Baseline

Current executable tools are registered in the shared server-side
`ToolRegistry`. MCP exposure already wraps registered tool manifests, so a new
Wazuh pack should be added as normal tools rather than as a special-case MCP
server.

Current local action tools include:

- `case.note.write`: sandbox file write.
- `command.run.sandbox`: preset low-risk local commands only.
- `full_access.exec`: arbitrary local program execution in full-access mode.

The Wazuh integration should not rely on `full_access.exec`. Wazuh is a
platform integration and should have typed API tools with explicit contracts.

Current persistence is file based. Wazuh run results should be represented as
normal agent run events, audit records, tool invocations, and evidence
artifacts. Durable session/Postgres work is a separate task.

## 3. Product Boundary

In scope:

- Wazuh API authentication and typed API client.
- Wazuh read-only tools for API health and agent inventory.
- Wazuh action tools for active response, starting with endpoint-side IP block.
- Tool manifests compatible with the existing web console and MCP facade.
- Audit and artifact output suitable for security operations review.

Out of scope for this slice:

- Generic arbitrary Wazuh API caller.
- Arbitrary shell/network commands such as ping, port scanning, or raw iptables.
- SIEM query language builder beyond the minimal alert/agent endpoints chosen
  for v0.
- Postgres-backed session history.
- Perimeter firewall, cloud WAF, EDR isolation, or network ACL integrations.
  Those should be separate tool packs.

## 4. Wazuh Access Model

Primary access path:

- Wazuh Server API over HTTPS, typically `https://<wazuh-manager>:55000`.
- Authenticate with Wazuh API user/password and cache JWT in memory.
- Send `Authorization: Bearer <token>` on API requests.

Configuration:

```env
WAZUH_API_URL=https://wazuh.example.local:55000
WAZUH_API_USER=secops-agent
WAZUH_API_PASSWORD=...
WAZUH_TLS_VERIFY=true
WAZUH_CA_CERT_PATH=optional/path/to/ca.pem
WAZUH_REQUEST_TIMEOUT_MS=15000
```

Credential handling:

- Do not expose credentials to the frontend.
- Do not persist Wazuh JWT to disk.
- Redact credentials and tokens from logs, audit events, and artifacts.
- Treat missing Wazuh config as explicit configuration error, not a fake/demo
  response.

Reference URLs:

- Wazuh API getting started:
  `https://documentation.wazuh.com/current/user-manual/api/getting-started.html`
- Wazuh OpenAPI spec:
  `https://raw.githubusercontent.com/wazuh/wazuh/v4.14.1/api/api/spec/spec.yaml`
- Wazuh Active Response scripts:
  `https://documentation.wazuh.com/current/user-manual/capabilities/active-response/default-active-response-scripts.html`

## 5. Tool Pack Design

Skill pack:

- `skillPackId`: `secops-wazuh`
- name: `Wazuh Platform`
- tags: `secops`, `wazuh`, `siem`, `active-response`
- MCP compatible: true

Read-only tools:

### `wazuh.health`

Purpose:

- Verify Wazuh API connectivity and authentication.

Input:

- none

Output:

- API reachable flag.
- Wazuh version when available.
- Authenticated user or RBAC summary when available.
- Base URL host only, not credentials.

Risk:

- low

### `wazuh.agents.list`

Purpose:

- List Wazuh agents for analyst scoping.

Input:

- `status?: "active" | "disconnected" | "never_connected" | "pending"`
- `name?: string`
- `ip?: string`
- `group?: string`
- `limit?: number`

Output:

- Agent id, name, IP, status, group, OS, last keepalive if available.

Risk:

- low

### `wazuh.agent.get`

Purpose:

- Inspect one Wazuh agent before action.

Input:

- `agentId: string`

Output:

- Agent identity, status, labels/groups, IP, OS, last keepalive, and relevant
  metadata.

Risk:

- low

Optional v0.5 read-only tool:

### `wazuh.alerts.search`

Purpose:

- Search recent alerts by source IP, agent, rule id, or time window.

Design note:

- This may require Wazuh Indexer/OpenSearch rather than only Wazuh Server API.
  Keep it optional until the deployment topology is confirmed.

## 6. IP Blocking Design

Do not expose arbitrary active response commands directly to the agent as the
primary user-facing operation. Add a semantic action tool:

### `wazuh.block_ip`

Purpose:

- Block a specific IP on explicit Wazuh agents using configured Active Response
  commands.

Input:

```json
{
  "ip": "203.0.113.10",
  "agentIds": ["001", "014"],
  "command": "firewall-drop",
  "durationSeconds": 3600,
  "reason": "Repeated brute force source in INC-2026-0017"
}
```

Validation:

- `ip` must be valid IPv4 or IPv6.
- `agentIds` must be non-empty. Do not default to all agents.
- `command` must be allowlisted.
- `durationSeconds` must be bounded by config.
- `reason` is required for auditability.

Initial command allowlist:

- `firewall-drop`: Linux/Unix iptables block.
- `firewalld-drop`: Linux firewalld block.
- `route-null`: Linux/Unix null route.
- `netsh`: Windows firewall block.

Execution:

- Use Wazuh Active Response API, not shell.
- Pass explicit `agents_list`.
- Request completion status when the API supports it.
- Capture Wazuh response body and status.

Risk:

- high

Permission behavior:

- `observe`: deny.
- `sandbox`: create approval if permission mode is `ask`; run immediately only
  if permission mode is `auto`.
- `full-access`: run automatically. This follows the existing project rule that
  full-access means automatic permission and complete capability surface.

Audit output:

- Policy decision.
- Wazuh API endpoint class, not full credential URL.
- Target IP.
- Target agent ids.
- Active Response command.
- Duration.
- Reason.
- Wazuh request id/status/result when available.

Artifact output:

- `kind`: `runtime`
- `title`: `Wazuh IP block: <ip>`
- `summary`: concise result.
- `data`: sanitized structured response.

## 7. Generic Active Response Tool

Add only after `wazuh.block_ip` is stable:

### `wazuh.active_response.run`

Purpose:

- Execute a configured Wazuh Active Response command on explicit agents.

Constraints:

- No arbitrary shell command.
- Command allowlist required.
- Explicit agents required.
- Structured arguments only.
- High risk action.

This tool is useful for future operations such as disabling a user, collecting
forensics, or triggering a custom Wazuh script, but it should not be the first
tool the agent reaches for when the user asks to block an IP.

## 8. Architecture Boundary

Recommended new owners:

- `apps/server/src/integrations/wazuh/client.ts`
  - HTTP client, auth, token caching, request timeout, TLS options.
- `apps/server/src/tools/wazuhTools.ts`
  - Tool manifests and tool handlers.
- `apps/server/src/tools/registry.ts`
  - Register Wazuh tools alongside existing SecOps and action tools.
- `packages/shared/src/index.ts`
  - Only update if new shared artifact or status contracts are needed.

Avoid:

- Adding Wazuh logic directly into `app.ts`.
- Reusing `full_access.exec` for Wazuh operations.
- Adding a generic API proxy that lets the browser or model call arbitrary
  Wazuh endpoints.

## 9. Error Handling

Required error classes:

- Missing Wazuh configuration.
- Authentication failed.
- Token expired and retry failed.
- TLS/certificate failure.
- Wazuh API timeout.
- Agent not found or disconnected.
- Command not allowed.
- Active Response returned partial failure.

Each error should produce:

- Tool invocation status `failed` or `denied`.
- Audit event with sanitized detail.
- No credential/token leakage.

## 10. Tests

Unit tests:

- Wazuh config parsing.
- Token redaction.
- IP validation.
- Agent id validation.
- Command allowlist validation.
- Active Response payload construction.

Server tests:

- `wazuh.health` succeeds against fake Wazuh server.
- Missing config fails explicitly.
- Auth token is cached and refreshed.
- `wazuh.block_ip` denies in observe mode.
- `wazuh.block_ip` creates approval in sandbox ask mode.
- `wazuh.block_ip` executes in full-access mode.
- Failed Wazuh response yields failed tool invocation and audit event.

Frontend checks:

- Wazuh skill pack appears in the skill list.
- Read-only Wazuh tools can be enabled/disabled like existing tools outside
  full-access.
- Full-access exposes all Wazuh tools.
- Failed Wazuh config is visible as a real error, not a demo response.

Testing notes:

- In the Codex filesystem sandbox, do not use `npm run build` or
  `npm run build -w apps/web` as Wazuh verification. Vite config loading has
  failed there with `Cannot read directory "../../../..": Access is denied`
  and `Could not resolve ... apps/web/vite.config.ts`.
- The same root/web build passed outside the sandbox, so treat the sandbox
  webbuild failure as a local sandbox permission limitation, not as a Wazuh code
  regression.
- Unless sandbox permissions change, use `npm run typecheck`,
  `npm run test -w apps/server`, and `npm run build -w apps/server` for
  repeatable sandbox verification instead of rerunning the sandboxed web build.

## 11. Manual Verification

With a real Wazuh API:

1. Configure Wazuh environment variables.
2. Start the API and web console.
3. Confirm `wazuh.health` returns a real version/auth result.
4. Confirm `wazuh.agents.list` returns real agents.
5. In sandbox ask mode, request an IP block and verify pending approval.
6. Approve the exact pending call and verify Wazuh receives the Active Response.
7. In full-access mode, request the same operation and verify it executes
   automatically.
8. Confirm audit/events/artifacts contain sanitized evidence.

## 12. Parallel Implementation Slices

Slice A: Wazuh client substrate

- Config parser.
- Auth/token cache.
- Typed request wrapper.
- Fake Wazuh server tests.

Slice B: Read-only tool pack

- `wazuh.health`
- `wazuh.agents.list`
- `wazuh.agent.get`
- Skill pack metadata.

Slice C: IP block action

- `wazuh.block_ip`
- Validation.
- Active Response request construction.
- Audit/artifact output.
- Permission behavior tests.

Slice D: Frontend and docs

- Skill list verification.
- README configuration section.
- Manual startup and verification notes.

## 13. Decision Needed Before Implementation

Choose the first real Wazuh target style:

1. Wazuh Server API only for v0.
2. Wazuh Server API plus Wazuh Indexer/OpenSearch for alert search.
3. Wazuh Server API plus a separate firewall/cloud block tool pack.

Recommendation:

- Start with option 1. It is the smallest useful integration and gives the
  agent real Wazuh platform operations without over-expanding the first slice.
  Add Indexer alert search and perimeter firewall blocking as later packs.
