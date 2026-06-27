---
name: shuffle-wazuh-alert-automation
description: Use when connecting Wazuh alerts to Shuffle SOAR workflows through webhooks or testing a Wazuh alert payload against a Shuffle webhook.
---

# Shuffle Wazuh Alert Automation

Shuffle and Wazuh commonly integrate through a Shuffle webhook trigger copied
into Wazuh Integrator configuration. Use this skill when the user asks to
forward, test, or reason about Wazuh alerts entering Shuffle.

## Workflow

1. Confirm the exact Shuffle webhook URL from the Shuffle trigger UI or Wazuh
   integration configuration.
2. If the user needs Wazuh configuration, call
   `shuffle.wazuh.integration.render` to render the `<integration>` XML
   snippet. This does not edit Wazuh files.
3. Inspect or construct one Wazuh alert JSON object.
4. If testing live delivery, call `shuffle.wazuh.alert.forward` with:
   - `webhookUrl`
   - `payloadJson`
   - optional `headersJson` when the Shuffle webhook requires header auth
   - `reason`
5. If the workflow id is known, use `shuffle.workflow.executions.list` to look
   for a resulting execution.
6. Use `shuffle.execution.result.get` only when you have the execution id and
   any required authorization value.

## Safety

- Webhook calls can start SOAR actions and must respect host approval.
- Do not claim Wazuh delivered an alert unless the webhook or execution evidence
  proves it.
- Distinguish "payload sent" from "Shuffle workflow completed".
- Do not print API keys, webhook auth headers, or full secrets.
