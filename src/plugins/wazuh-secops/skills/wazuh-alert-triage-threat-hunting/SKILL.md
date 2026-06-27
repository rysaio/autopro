---
name: wazuh-alert-triage-threat-hunting
description: Use when triaging Wazuh alerts, summarizing rule activity, hunting suspicious IPs, or deciding which Wazuh-managed Linux host needs deeper investigation.
---

# Wazuh Alert Triage And Threat Hunting

Use Wazuh Indexer alert data and Wazuh Server API inventory. Keep alert evidence
separate from hypotheses.

## Workflow

1. Check readiness with `wazuh.config.status`.
2. Establish a bounded time window. Default to 60 minutes when unspecified.
3. Start broad with `wazuh.rule.hits.summary` to identify noisy or high-level
   rules, affected agents, and rule groups.
4. Drill into relevant alerts with:
   - `wazuh.alerts.search`
   - `wazuh.agent.alerts.timeline`
   - `wazuh.ip.activity.timeline`
5. Map impacted hosts with `wazuh.agents.list`, `wazuh.agent.get`, and
   `wazuh.agent.network.summary`.
6. For lateral or internal-network patterns, hand off to:
   - `wazuh.lateral.suspects`
   - `wazuh.lateral.path.summary`
   - `wazuh.host.neighbors`

## Output Rules

- Include time window, rule ids, rule levels, agent ids, and IPs.
- Separate "Observed alert evidence" from "Hypothesis".
- Do not claim compromise or lateral movement unless Wazuh alert content
  directly supports it.
- Prefer next read-only Wazuh queries before recommending containment.
