# 任意已安装插件工具的通用路由发现（Issue #4）— 实施记录

日期：2026-08-12
状态：已完成

## 1. 背景与目标

确定性路由此前只认识第一方 skill pack 与硬编码名称前缀（`wazuh.`、`shuffle.`、
`secops_report_` 等）。任意第三方插件工具要么落入 `core-triage`（在部分高置信度
请求中被连带暴露），要么因为前缀不识别而无法被路由命中；而插件 `_meta` 缺失
`deferLoading` 时默认常驻，又会让“没有元数据的未知工具”永久占用 triage 上下文。

目标：让任意已安装的 Codex/MCP 兼容插件工具在 reload 后即可被确定性路由发现，
不需要第一方插件名或硬编码前缀；同时保持 deferred 工具只在请求命中其路由提示时
暴露，不会进入每一次无关模型请求。

## 2. 设计决策

| 决策 | 定稿 |
|---|---|
| 可选路由元数据 | `SkillManifest.routing?: { group?: string; keywords?: string[] }`；来源为插件 manifest（`.codex-plugin/plugin.json` 的 `routing`）与 MCP 工具 `_meta.routing`，per-tool 优先 |
| 元数据校验 | 只接受非空字符串 group 与非空字符串数组 keywords；缺失、类型错误、空值一律忽略并回退到派生提示 |
| 标签来源 | 插件 `keywords` + `_meta.tags` + MCP `annotations`（`readOnlyHint`/`destructiveHint`/`openWorldHint` 派生出 `read-only`/`destructive`/`open-world`）+ 插件 id，全部去重 |
| 缺失 `deferLoading` | 插件工具默认 `true`（按需/deferred）。显式 `false` 仍表示常驻。此默认值修正了“缺省即常驻”导致未知插件工具永久 resident 的问题 |
| 通用发现池 | 只包含未命中第一方 skill pack/前缀规则的 deferred 工具（含未知 action 工具）；常驻工具本就可见，无需进入发现池 |
| 匹配信号 | 显式 `keywords`/`group` 命中为强信号；否则从 id、name、description、tags、keywords、group 派生词项（英文词 + 中文 2-gram）与意图做重叠计分，达到阈值才选中 |
| 安全回退 | 派生提示为空或不足以匹配时，工具保持 deferred，不进入 triage，也不进入不相关的高置信度路由；用户仍可通过 `PUT /api/tools/visibility/:id` 显式设为常驻 |
| 路由重建 | `ToolRouter.build()` 每次 route 前重建发现索引；插件 reload 后注册表变化立即反映，移除的插件工具随之消失 |
| 既有行为 | 第一方分类规则、分层回滚路径、`enabledTools` 交集与 action 权限过滤保持不变 |

## 3. 变更文件

- `src/packages/shared/src/index.ts`：新增 `ToolRoutingHints` 与 `SkillManifest.routing`
- `src/plugins/wazuh-secops/src/tools/types.ts`、`src/plugins/shuffle-secops/src/tools/types.ts`：插件侧 `SkillManifest` 增加可选 `routing`
- 两个插件 `src/adapters/mcpServer.ts`：`_meta` 透传 `routing`
- `src/apps/server/src/plugins/pluginManager.ts`：读取并校验插件 `keywords`/`routing`；合并标签；缺失 `deferLoading` 默认 deferred；MCP `_meta` 路由元数据与注解派生
- `src/apps/server/src/runtime/toolRouter.ts`：构建通用发现索引；`getIntentToolIds` 在无信号命中时只保留常驻工具；未知请求命中通用提示时选中 deferred 工具
- 测试：`pluginManager.test.ts`、`toolRouter.test.ts`、`toolCatalogApi.test.ts`
- 文档：本文件与 `README.md`

## 4. 验收标准映射

| 验收标准 | 覆盖 |
|---|---|
| 泛化命名的测试插件 reload 后无需重启即可路由 | `toolCatalogApi.test.ts`：安装 `generic-demo` → `POST /api/plugins/reload` → agent run 路由包含 `demo.customer.search` |
| 匹配 description 的请求选中该工具，不依赖硬编码前缀 | `toolRouter.test.ts`：`demo.customer.search` 通过 description/tags 命中 |
| 同一 deferred 工具不出现在无关高置信度请求 | `toolRouter.test.ts` + `toolCatalogApi.test.ts`：IOC 请求不包含客户搜索工具 |
| reload 重建发现并移除已卸载工具 | `toolRouter.test.ts`（`unregisterExternalTools` 后重建）+ `toolCatalogApi.test.ts`（删除插件目录后 reload） |
| 与 `enabledTools` 和权限策略取交集 | `toolRouter.test.ts`：enabledTools 排除与 action 的 deny/ask 场景 |
| 缺失/无效路由元数据的安全回退，不使未知工具永久常驻 | `pluginManager.test.ts`（无效 `deferLoading`/`routing` 回退）+ `toolRouter.test.ts`（metadata-poor 工具不 resident） |
| 不要求插件专属实现代码 | 测试全部通过泛化插件生命周期完成；wazuh/shuffle 只做可选字段透传 |
| 既有第一方与 reload 行为继续通过 | server 188 项测试全绿；插件与 web 的 tsx 启动类测试受本机 `os.userInfo()` ENOMEM 环境问题影响，与本次改动无关 |

## 5. 验证命令

```powershell
cd src
npm run typecheck
npm test -w @secops-agent/server
```

## 6. 明确不做

- 语义向量/embedding 工具搜索（后续插件规模增长再评估）
- MCP 协议层延迟加载改动（`deferLoading` 仍为主服务 API 层概念）
- 为 wazuh/shuffle 等第一方插件编写专属路由代码
