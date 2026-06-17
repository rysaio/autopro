# Shuffle SecOps Plugin

这是可复用的 Shuffle SOAR 工具包，也是 Agent Skills 与 MCP stdio 包装。它是 Shuffle 领域能力的唯一 owner；主应用若需要 Shuffle，只应加薄适配。

## 当前能力

- Shuffle REST API client，使用 `Authorization: Bearer <api key>`。
- 脱敏配置状态检查与 host-neutral Shuffle tool registry。
- 工作流查看、执行、执行列表、执行结果读取。
- Shuffle app 列表，用于能力发现。
- Webhook trigger 与 Wazuh alert forwarding helper。
- Wazuh Integrator XML renderer，辅助把 Wazuh alert 转发到 Shuffle webhook。
- Shuffle 2.2.1+ 内置 HTTP MCP 调用 helper。
- MCP stdio server、Codex plugin manifest、Agent Skill folders。

## 环境变量

```bash
SHUFFLE_API_URL=https://shuffle.example/api/v1
SHUFFLE_API_KEY=shuffle-api-key
SHUFFLE_ORG_ID=optional-org-id
```

Smoke:

```bash
SHUFFLE_SMOKE_WORKFLOW_ID=workflow-id
SHUFFLE_SMOKE_WEBHOOK_URL=https://shuffle.example/api/v1/hooks/webhook-id
```

工作流执行默认跳过；只有同时设置以下变量才会执行：

```bash
SHUFFLE_SMOKE_EXECUTE_WORKFLOW=true
SHUFFLE_SMOKE_CONFIRM=execute-shuffle-workflow
```

不要把凭证写进 URL；使用 `SHUFFLE_API_KEY`。

## 验证

沙箱内优先跑：

```bash
npm run test -w plugins/shuffle-secops
npm run build -w plugins/shuffle-secops
npm run smoke:shuffle -w plugins/shuffle-secops
npm pack -w plugins/shuffle-secops --dry-run
```

不要用沙箱内 root/web Vite build 验证本插件；现有项目记录显示那会受本地文件系统沙箱权限影响。

## CLI

Build 后可按 manifest id 或 API name 调一个工具：

```bash
node dist/bin/shuffle-tool.js shuffle.config.status '{}'
```

动作工具只有同时设置以下变量才会执行：

```bash
SHUFFLE_CLI_ALLOW_ACTIONS=true
SECOPS_ACTION_LEVEL=full-access
```

## 复用方式

- Generic MCP host：先 build，再从本目录运行 `node dist/bin/shuffle-mcp.js`。
- Codex：使用 `.codex-plugin/plugin.json`，其入口指向 `skills/` 和 `.mcp.json`。
- 其他 Agent Skills host：直接复用 `skills/` 并配置同一个 MCP server。
- 主应用后续集成：只加薄适配，保持本 package 是 Shuffle 领域 owner。

## MCP 动作边界

Standalone MCP 默认安全只读。工作流执行、webhook trigger、Wazuh alert forwarding、Shuffle MCP call 都是动作工具，只有同时设置以下变量才可执行：

```bash
SHUFFLE_MCP_ALLOW_ACTIONS=true
SECOPS_ACTION_LEVEL=full-access
```

有自有审批系统的 host 应绕过 standalone action 开关，直接适配 package tools，并让 host 继续拥有审批与审计。

## 安全边界

- 插件通过 Shuffle REST、Webhook 和内置 MCP 接口工作，不通过 shell 检查 endpoint。
- Webhook URL 形态随 Shuffle 版本变化；生产使用时从 Shuffle trigger UI 复制精确 URL。
- 动作工具必须显式目标、reason-required，并由 host 审批/审计。
