---
name: wazuh-active-response-operations
description: Use when preparing or requesting Wazuh Active Response containment such as blocking an IP with explicit agents, duration, reason, and host approval.
---

# Wazuh Active Response Operations

Use this skill for controlled Wazuh Active Response operations. The host owns
approval. Never bypass it.

## Workflow

1. Check Wazuh readiness with `wazuh.config.status`.
2. Confirm the target IP is valid and relevant to the current investigation.
3. Gather recent context with `wazuh.alerts.search` when Indexer is configured.
4. Identify explicit Wazuh agent ids with `wazuh.agents.list` or
   `wazuh.agent.get`.
5. Ask for or derive a clear reason and bounded duration.
6. Use `wazuh.block_ip` only with:
   - `ip`
   - explicit `agentIds`
   - allowlisted `command`
   - `durationSeconds`
   - `reason`

## Safety Rules

- In observe mode, expect the action to be denied.
- In sandbox ask mode, expect a pending approval.
- In full-access mode, execution is still limited to allowlisted Wazuh Active
  Response commands.
- Do not issue generic Active Response commands.
- Do not put credentials, tokens, or passwords in outputs.
