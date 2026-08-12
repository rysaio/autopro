# 插件、技能与工具工作区重构

日期：2026-08-10

状态：已实施（2026-08-12）

## 产品模型

产品提供三个互相独立的工作区：

- 插件：展示已安装插件、插件状态、技能数量、工具数量及插件自带 MCP 连接状态。
- 技能：展示独立技能与插件来源技能，支持查看正文和手动重载。
- 工具：管理模型可调用的工具、风险范围与延迟加载；独立 MCP 服务配置位于“工具 > MCP 服务”。

插件可以包含技能和 MCP server，但插件不是技能，技能也不是工具。前端不把三者合并为一个目录。

## 模块职责

### Plugin Manager

负责插件发现、manifest 校验、插件 MCP 生命周期和插件总体状态。纯技能插件、纯 MCP 插件以及同时包含二者的插件都可加载。

### Skill Catalog

负责技能发现、索引、正文读取和重载。内部保留文件位置，对外只返回 ID、名称、描述、来源、状态及受控的正文读取结果。

### Tool Registry

只负责工具注册、查询、执行、审批、风险和延迟加载策略，不包含展示分组模型。

### MCP Server Manager

负责不属于插件的 stdio 与 Streamable HTTP 服务配置、启停、重连和删除。配置变化即时同步到 Tool Registry。

## API

```text
GET  /api/plugins
POST /api/plugins/reload
GET  /api/skills
GET  /api/skills/:id
POST /api/skills/reload
GET  /api/tools
GET  /api/mcp/servers
POST /api/mcp/servers
PUT  /api/mcp/servers/:id
DELETE /api/mcp/servers/:id
POST /api/mcp/servers/:id/reconnect
POST /api/mcp/servers/reload
```

插件与技能接口分别返回各自的数据。插件摘要只返回 `skillCount`，不会嵌入技能列表；技能正文由单独接口按需读取。

## 验收标准

- 侧边栏存在独立的“插件”“技能”“工具”入口。
- 插件页不嵌入技能行，技能页可区分独立与插件来源。
- 工具页不按额外分组模型组织。
- 独立 MCP 服务只在“工具 > MCP 服务”中配置。
- 新增、编辑、启停、重连、删除和从文件重载 MCP 服务均无需重启。
- 工具审批、审计和 `deferLoading` 行为保持不变。
- 源码开发与 runnable 使用相同的运行目录结构和加载规则。

