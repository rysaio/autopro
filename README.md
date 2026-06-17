# SecOps Agent Console

这是一个 TypeScript 优先的安全运营 agent web 应用。项目不是固定剧本编排器，而是让模型在受控权限、审计和工具注册边界内发挥 SecOps 技能与 MCP 工具。

## 新 Agent 接手顺序

1. 先读本 README，确认当前进度和下一步任务。
2. 读 `docs/architecture.md`，理解运行时、权限、审批、MCP 边界。
3. 读 `docs/aegis/INDEX.md`，找到已完成工作总结和仍有效的计划。
4. 做 Wazuh 或 Shuffle 工作时，优先读对应插件 README：
   - `plugins/wazuh-secops/README.md`
   - `plugins/shuffle-secops/README.md`
5. 开始编码前先跑 `git status --short`，不要覆盖用户未提交改动。

## 当前进度

- 主应用已成型：`apps/server` 是 Fastify API + AI SDK agent runtime；`apps/web` 是 React/Vite 控制台；`packages/shared` 放共享类型。
- 权限和审计已成型：支持 `observe`、`sandbox`、`full-access`，动作工具可进入待审批队列，运行事件写入本地 JSONL。
- Wazuh 插件已抽出为 `plugins/wazuh-secops`：包含 npm 包、MCP stdio、Codex manifest、Agent Skills、只读网络/横向分析工具和受控 Active Response。
- Shuffle 插件已抽出为 `plugins/shuffle-secops`：包含 npm 包、MCP stdio、Codex manifest、Agent Skills、工作流/执行/Webhook/Wazuh 转发/Shuffle MCP 工具。
- Wazuh 已接入主应用，Shuffle 目前是独立插件包；主应用里的 Shuffle 薄适配仍是后续任务。

## 下一步任务

1. 若目标是让 Web 控制台直接使用 Shuffle：在 `apps/server` 增加 `@secops-agent/shuffle-secops` 薄适配，保持审批、审计、UI 归主应用所有。
2. 用真实环境做 live smoke：Wazuh 需要真实 API/Indexer；Shuffle 需要 `SHUFFLE_API_URL` 和 `SHUFFLE_API_KEY`。
3. 补长期会话能力：当前聊天 session 尚未做持久恢复，Postgres run/session storage 也未实现。
4. 保持边界：领域工具逻辑留在 `plugins/*`，主应用只做 host policy、审批、审计和 UI。

## 目录地图

- `apps/server`：API、agent runtime、工具注册、审批、审计、MCP Streamable HTTP。
- `apps/web`：本地 SecOps 控制台，默认 Vite 端口 `5317`。
- `packages/shared`：运行、工具、审计、UI 共享契约。
- `plugins/wazuh-secops`：可复用 Wazuh SecOps 工具包和技能包。
- `plugins/shuffle-secops`：可复用 Shuffle SOAR 工具包和技能包。
- `docs/aegis`：计划、规格、完成摘要和验证记录入口。

## 本地启动

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

默认地址：

- Web: `http://localhost:5317`
- API: `http://localhost:4317`
- Health: `GET http://localhost:4317/api/health`

停止本项目的后台开发进程：

```powershell
npm run stop:dev
```

## 配置提示

- 模型配置看 `.env.example` 或 `secops.config.example.json`。
- Wazuh live 配置看 `plugins/wazuh-secops/README.md`。
- Shuffle live 配置看 `plugins/shuffle-secops/README.md`。
- 不要把凭证写进 URL；使用专门的 key/user/password 环境变量。
- 对外暴露 API 时必须设置精确的 `SECOPS_ALLOWED_HOSTS`、`SECOPS_ALLOWED_ORIGINS`，并配置 `SECOPS_API_TOKEN`。

## 常用验证

```bash
npm run test -w plugins/wazuh-secops
npm run build -w plugins/wazuh-secops
npm run test -w plugins/shuffle-secops
npm run build -w plugins/shuffle-secops
npm run smoke:shuffle -w plugins/shuffle-secops
npm run test -w apps/server
npm run typecheck
npm run build -w apps/server
```

在当前 Codex 文件系统沙箱里，不要把 `npm run build` 或 `npm run build -w apps/web` 当作有效验证信号；已有记录显示 Vite 配置加载会撞到沙箱读目录权限限制。需要验证 Web 时，优先在非沙箱环境跑 root/web build 或通过浏览器手动检查。

## 安全边界

- `observe` 只允许只读工具。
- `sandbox` 允许受控本地写入和低风险命令；动作工具通常走审批。
- `full-access` 会自动授权完整能力面，包括可跨 workspace 的 `full_access.exec`，只应在明确需要时使用。
- Wazuh 和 Shuffle 的动作工具必须保持显式目标、理由必填、由 host 审批/审计拥有。

## 文档维护规则

- 根 README 保持中文、短、面向接手；不要再堆完整工具清单。
- 详细工具说明放插件 README，历史证据放 `docs/aegis/work/*/SUMMARY.md`。
- 单个文档尽量控制在 100 行内；过长内容拆到更具体的文档。
- 新增计划或完成摘要后，同步更新 `docs/aegis/INDEX.md`。
