---
name: shuffle-mcp-bridge
description: Use when calling Shuffle's built-in HTTP MCP or Agent API through the Shuffle SecOps wrapper.
---

# Shuffle MCP Bridge

Shuffle 2.2.1+ documents a built-in HTTP MCP API. Use the local
`shuffle.mcp.call` wrapper when the user wants to reach Shuffle-native MCP
methods from an agent host that is already using this package.

## Workflow

1. Use `shuffle.config.status` and `shuffle.health` to confirm API readiness.
2. Start with low-risk methods such as `ping` or `tools/list` when discovering
   the remote Shuffle MCP surface.
3. Use `shuffle.mcp.call` with:
   - `method`
   - optional JSON object `paramsJson`
   - `reason`
4. For `tools/call`, inspect the remote tool name and arguments carefully before
   invoking.

## Safety

- Treat `shuffle.mcp.call` as action-classed because remote MCP methods may run
  SOAR actions.
- Never bypass host approval.
- If Shuffle returns an async handle or stream id, poll only through documented
  Shuffle APIs and state what is still pending.
