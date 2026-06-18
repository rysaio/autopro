# Aegis Index

Start here after the root README when an agent needs project progress or next tasks.

## Specs

- `2026-06-15` spec: [Wazuh MCP Tools Spec Brief](specs/2026-06-15-wazuh-mcp-tools-brief.md)
- `2026-06-15` spec: [Wazuh SecOps Plugin Extraction Design](specs/2026-06-15-wazuh-plugin-extraction-design.md)
- `2026-06-19` spec: [Agent Control Boundary Design](specs/2026-06-19-agent-control-boundary-design.md)

## Plans

- `2026-06-15` plan: [Wazuh SecOps Plugin Extraction](plans/2026-06-15-wazuh-plugin-extraction.md)
- `2026-06-16` plan: [Shuffle SecOps Plugin](plans/2026-06-16-shuffle-secops-plugin.md)
- `2026-06-19` plan: [Agent Control Boundary Implementation](plans/2026-06-19-agent-control-boundary.md)

## Work Records

- `2026-06-14` work summary: [SecOps Agent Web](work/2026-06-14-secops-agent-web/SUMMARY.md)
- `2026-06-15` work summary: [Wazuh MCP Tools](work/2026-06-15-wazuh-mcp-tools/SUMMARY.md)
- `2026-06-15` work summary: [Wazuh SecOps Plugin Extraction](work/2026-06-15-wazuh-plugin-extraction/SUMMARY.md)
- `2026-06-16` work summary: [Shuffle SecOps Plugin](work/2026-06-16-shuffle-secops-plugin/SUMMARY.md)
- `2026-06-19` work summary: [Agent Control Boundary](work/2026-06-19-agent-control-boundary/SUMMARY.md)

## ADRs

- `2026-06-19` ADR: [Agent Control Boundary and Durable Session State](adr/2026-06-19-agent-control-boundary.md)

## Current Next Tasks

- Run `SECOPS_TEST_DATABASE_URL` backed Postgres integration checks for `2026-06-19` Agent Control Boundary.
- Manually verify Web console rendering for guidance, denial, hard failure, and pending approval states.
- Integrate Shuffle into `apps/server` through a thin adapter only if the Web console needs it.
- Run live Wazuh and Shuffle smoke checks when real credentials are available.
