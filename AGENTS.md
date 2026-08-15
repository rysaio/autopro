## AGENTS.md

- 当前开发环境是 WSL2 (Ubuntu Linux) / Bash。Windows 11 / pwsh 7 仅作为兼容环境，不应作为默认命令环境。
- 命令默认使用 Bash 语法；只有明确需要 Windows 侧操作时才使用 pwsh，并在命令前标注 `pwsh`。
- 源码工作区在 `src/`，依赖安装、测试和启动均使用 `npm`；Node.js 为 24 LTS。
- 复杂正则优先用单引号包裹；如果正则同时包含单引号和双引号，拆成多个简单 `rg` 命令。
- 在 Bash 下可直接使用 glob；若 `rg` 在 WSL 跨文件系统（如 /mnt/c）搜索异常，改用 `git grep` 或缩小搜索范围。
- 服务端单元/集成测试使用 `npx vitest run apps/server/test`，不要假设测试环境是 Windows 路径。

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for `rysaio/autopro`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five canonical triage labels defined for this repository. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context domain documentation layout. See `docs/agents/domain.md`.
