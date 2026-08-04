# Wazuh SecOps Plugin

这是可复用的 Wazuh 安全运营工具包，也是 Agent Skills 与 MCP stdio 包装。它是 Wazuh 领域能力的唯一 owner；主应用只做审批、审计、权限和 UI 适配。

## 当前能力

- Wazuh Server API client 与 Indexer/OpenSearch alert search client。
- 脱敏配置状态检查：不会输出密码、token 或完整凭证。
- Host-neutral Wazuh tool registry，可被主应用、MCP host、CLI 复用。
- 只读网络与横向分析 helper：
  - network exposure map
  - agent alert timeline
  - IP activity timeline
  - rule hits summary
  - network service finder
  - host neighbors
  - lateral suspects
  - lateral path summary
- MCP stdio server、Codex plugin manifest、Agent Skill folders。
- 受控动作工具 `wazuh.block_ip`，必须保持显式 agent、IP、命令、时长和理由。

## 环境变量

Server API:

```bash
WAZUH_API_URL=https://wazuh.example:55000
WAZUH_API_USER=wazuh-user
WAZUH_API_PASSWORD=wazuh-password
```

Indexer:

```bash
WAZUH_INDEXER_URL=https://wazuh-indexer.example:9200
WAZUH_INDEXER_USER=indexer-user
WAZUH_INDEXER_PASSWORD=indexer-password
WAZUH_ALERTS_INDEX=wazuh-alerts-*
```

Smoke:

```bash
WAZUH_SMOKE_AGENT_ID=001
WAZUH_SMOKE_ALERT_SOURCE_IP=10.0.0.5
WAZUH_SMOKE_BLOCK_IP=203.0.113.10
```

不要把凭证写进 URL；使用专门的 user/password 变量。

## 验证

沙箱内优先跑：

```bash
npm run test -w plugins/wazuh-secops
npm run build -w plugins/wazuh-secops
npm run smoke:wazuh -w plugins/wazuh-secops
npm run test -w apps/server
npm run typecheck
npm run build -w apps/server
```

注意：Vite 构建在某些沙箱/受限环境中可能失败，建议在标准开发环境中验证。

## 复用方式

- 主应用：`apps/server/src/tools/wazuhTools.ts` 只做薄适配。
- Generic MCP host：先 build，再从本目录运行 `node dist/bin/wazuh-mcp.js`。
- Codex：使用 `.codex-plugin/plugin.json`，其入口指向 `skills/` 和 `.mcp.json`。
- 其他 Agent Skills host：直接复用 `skills/` 并配置同一个 MCP server。

## MCP 动作边界

Standalone MCP 默认安全只读。动作工具如 `wazuh.block_ip` 只有同时设置以下变量才可执行：

```bash
WAZUH_MCP_ALLOW_ACTIONS=true
SECOPS_ACTION_LEVEL=full-access
```

有自有审批系统的 host 应绕过 standalone action 开关，直接适配 package tools，并让 host 继续拥有审批与审计。

## 安全边界

- 插件必须通过 Wazuh API/Indexer 工作，不通过 shell 检查 endpoint。
- 动作工具必须 allowlist、reason-required、duration-bound。
- 审批和审计归 host，不归插件。
