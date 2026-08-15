# shell-secops

Codex-style MCP plugin for SecOps Agent Console. It exposes a real `run_shell` tool.

The host service decides whether the call is allowed (actionLevel, permissionMode, risk) before the plugin process executes the command. The plugin runs commands in `SECOPS_SANDBOX_ROOT` when provided.
