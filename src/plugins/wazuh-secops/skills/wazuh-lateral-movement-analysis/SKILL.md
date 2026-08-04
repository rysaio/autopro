---
name: wazuh-lateral-movement-analysis
description: Use when investigating suspected internal lateral movement, east-west traffic, host pivoting, brute force, remote execution, or service discovery using Wazuh alerts and Linux agent inventory.
---

# Wazuh Lateral Movement Analysis

Use Wazuh alerts and Wazuh syscollector inventory to build evidence-backed
hypotheses. Keep direct evidence separate from inference.

## Workflow

1. Start with `wazuh.config.status` and confirm both Server API and Indexer
   readiness.
2. Establish a bounded time window, defaulting to 60 minutes if the user does
   not specify one.
3. Start alert context with `wazuh.rule.hits.summary` or `wazuh.alerts.search`
   using any available source IP, agent id, rule id, or time window.
4. Map Wazuh agent ids and internal IPs with `wazuh.agents.list`,
   `wazuh.agent.get`, and `wazuh.agent.network.summary`.
5. Map exposed services with `wazuh.network.exposure.map` and
   `wazuh.network.service.find` when the question involves pivots or reachable
   targets.
6. For graph-style correlation, prefer:
   - `wazuh.host.neighbors`
   - `wazuh.ip.activity.timeline`
   - `wazuh.lateral.suspects`
   - `wazuh.lateral.path.summary`
7. For each suspicious internal source or target, inspect listening ports and
   related processes with `wazuh.agent.ports.list` and
   `wazuh.agent.processes.list`.

## Output Rules

- Separate "Observed evidence" from "Inferred path".
- Include rule ids, agent ids, IPs, and time windows when available.
- State missing evidence plainly, especially when Indexer configuration or
  Linux syscollector data is unavailable.
- Do not claim confirmed lateral movement unless Wazuh alert content directly
  supports that conclusion.
