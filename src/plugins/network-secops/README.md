# network-secops

Codex-style MCP plugin for SecOps Agent Console. It exposes real `http_request` and `dns_lookup` tools.

The host service decides whether an HTTP action is allowed (actionLevel, permissionMode, risk) before the plugin process executes it. DNS lookup is read-only and always available.
