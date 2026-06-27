---
name: wazuh-linux-network-monitoring
description: Use when inspecting Linux host network posture through Wazuh-managed agent data, including interfaces, addresses, listening ports, related processes, and internal exposure.
---

# Wazuh Linux Network Monitoring

Use Wazuh tools only. Do not run endpoint shell commands.

## Workflow

1. Check Wazuh readiness with `wazuh.config.status`.
2. If no agent id is provided, scope candidates with `wazuh.agents.list`.
3. Inspect the target host with `wazuh.agent.get`.
4. Prefer `wazuh.agent.network.summary` for the first host view.
5. Drill down with these tools when needed:
   - `wazuh.agent.netiface.list`
   - `wazuh.agent.netaddr.list`
   - `wazuh.agent.ports.list`
   - `wazuh.agent.processes.list`
6. Summarize:
   - bound addresses and subnets
   - listening or externally reachable services
   - process names tied to suspicious ports when Wazuh has the data
   - evidence gaps and the next Wazuh read-only query

## Constraints

- Treat syscollector data as a Wazuh inventory snapshot, not live packet
  capture.
- Label stale or missing Wazuh data as an evidence gap.
- Do not recommend shell commands unless the user explicitly asks outside this
  skill.
