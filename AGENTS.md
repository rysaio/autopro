## AGENTS.md

- 当前环境是windows 11 / pwsh 7
- 不要使用 Bash 引号/转义习惯，在 PowerShell 命令里，复杂正则优先用单引号包裹。
- 如果正则本身同时包含单引号和双引号，优先拆成多个简单 rg 命令。
- PowerShell 使用 rg 时，通配目录必须先用 `Get-ChildItem -Filter` 展开为真实路径，禁止直接把含 `*` 的搜索路径传给 rg

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for `rysaio/autopro`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage labels defined for this repository. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context domain documentation layout. See `docs/agents/domain.md`.
