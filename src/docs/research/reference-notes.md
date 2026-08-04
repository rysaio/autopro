# Reference Notes

## Sources Consulted

- DashScope OpenAI-compatible docs: base URL
  `https://dashscope.aliyuncs.com/compatible-mode/v1`, chat completions endpoint,
  and tool/function calling support.
- `anomalyco/opencode`: open-source coding agent with multi-package repo shape
  and terminal-first agent UX.
- `shareAI-lab/learn-claude-code`: agent product framing as model plus harness:
  tools, knowledge, observation, action interfaces, permissions.
- `simon-p-j-r/LLM4Pentest`: current cybersecurity-agent resource taxonomy.

## Design Consequences

- Keep the agent loop simple: model call, optional tool calls, tool results,
  repeat.
- Put complexity around the loop: tool manifests, permissions, audit, evidence,
  and UI inspection.
- Avoid fixed SOP orchestration. The model decides tool use within a bounded
  skill surface.
- Start with read-only or evidence-producing SecOps tools.
- Make the Qwen provider an adapter so future model providers do not change the
  runtime loop.
- Represent provider capabilities explicitly. Qwen can use OpenAI-compatible
  tools, while tool-call streaming should remain a separate capability flag.
- Treat permission decisions as first-class audit events, even when a low-risk
  tool is auto-approved.
