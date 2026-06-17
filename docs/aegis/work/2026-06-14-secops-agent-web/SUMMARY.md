# SecOps Agent Web Summary

Date: 2026-06-14
Status: closed summary

Built the initial TypeScript-first SecOps agent web app with a Fastify API,
React/Vite console, shared contracts, AI SDK runtime, OpenAI-compatible model
configuration, MCP/skill-style tool registry, local audit log, pending approval
store, sandbox actions, full-access execution capability, and Streamable HTTP
MCP exposure.

Current verified surfaces:

- Real Qwen-compatible provider configuration works through local config/env.
- Web console can send agent messages with Enter and stream run events.
- Tools are grouped into skill packs and exposed through API and MCP facades.
- Action levels support `observe`, `sandbox`, and `full-access`.
- Full access means automatic permission, all tools exposed, and cross-workspace
  execution for `full_access.exec`.
- Runtime settings, pending approvals, and audit events persist to local files.
- Product mock/fallback model behavior was removed from runtime code.

Remaining product gaps:

- Chat sessions are not yet restored as durable conversations.
- Postgres-backed run/session storage is not implemented.
- External SecOps platform integrations, including Wazuh, are future work.
