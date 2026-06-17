---
name: wazuh-network-exposure-mapping
description: Use when mapping internal network exposure across Wazuh-managed Linux agents, including shared subnets, listening services, bound addresses, and exposed service owners.
---

# Wazuh Network Exposure Mapping

Use Wazuh Server API and syscollector inventory only. Do not run endpoint shell
commands or packet capture commands.

## Workflow

1. Check readiness with `wazuh.config.status`.
2. Scope agents with `wazuh.agents.list`, preferring active Linux agents when
   the user has not selected hosts.
3. Build the first exposure view with `wazuh.network.exposure.map`.
4. For a target service, narrow with `wazuh.network.service.find`.
5. For important hosts, inspect details with:
   - `wazuh.agent.network.summary`
   - `wazuh.agent.ports.list`
   - `wazuh.agent.processes.list`
6. Summarize:
   - direct syscollector evidence
   - shared subnets and bound addresses
   - externally risky services
   - hosts needing follow-up alert review
   - stale or missing inventory gaps

## Output Rules

- Treat exposure as an inventory-derived finding, not proof of active traffic.
- Call out whether a service is bound to loopback, a private address, or a
  wildcard address when Wazuh provides the field.
- Keep recommendations read-only unless the user explicitly asks for active
  response handling.
