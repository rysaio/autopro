---
name: shuffle-workflow-operations
description: Use when operating Shuffle SOAR workflows through the Shuffle SecOps MCP tools: checking readiness, listing workflows, inspecting a workflow, executing an approved workflow, or reading execution results.
---

# Shuffle Workflow Operations

Use Shuffle MCP tools before making claims about workflows. Prefer read-only
inspection first.

## Workflow

1. Run `shuffle.config.status` if API readiness is unclear.
2. Run `shuffle.health` to verify API authentication when live access is needed.
3. Run `shuffle.workflows.list` to identify candidate workflows.
4. Run `shuffle.workflow.get` before executing a workflow unless the user gave a
   precise workflow id and purpose.
5. For workflow execution, call `shuffle.workflow.execute` only with:
   - explicit `workflowId`
   - JSON object argument in `executionArgumentJson`
   - clear `reason`
6. Use `shuffle.workflow.executions.list` and `shuffle.execution.result.get` to
   monitor outcomes when an execution id is available.

## Safety

- Treat `shuffle.workflow.execute` as side-effecting.
- Never bypass host approval.
- Do not invent workflow ids or webhook URLs.
- Report whether a result is direct execution evidence or only a request being
  submitted.
