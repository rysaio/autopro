# 模型客户端复用与连接生命周期观测（Issue #9）— 实施记录

日期：2026-08-11
状态：已完成

## 1. 背景与目标

父 issue #1 用户故事 29：同一活动连接配置下的连续与并发 agent run 复用同一个
provider client，而不是每次重建；配置修订后停止复用；移除/重载时释放旧 client；
生命周期指标独立于模型请求时长可观测；日志与缓存标识绝不包含 API key 或授权头。

## 2. 定稿设计

| 决策 | 定稿 |
|---|---|
| 缓存键 | 连接 id + 配置指纹（provider/model/baseUrl/apiKey 的 SHA-256 摘要，不可逆） |
| 并发安全 | JS 单线程 Map + 引用计数（acquire/release）；并发 run 共享同一 LanguageModel 实例（AI SDK 无状态工厂产物，符合 provider SDK 生命周期） |
| 失效路径 | PUT/DELETE `/api/model-config/:id` → `invalidate(id)`；`POST /api/model-config/reload` → `invalidateAll()`；活跃引用归零后才 dispose |
| 清理 | 可选 `disposeModel`（provider 暴露清理操作时启用）；AI SDK LanguageModel 无 dispose，默认跳过 |
| 请求相关工厂 | `BuildServerOptions.createModel`（测试注入，依赖请求）保持每次新建，不缓存 |
| 指标 | `GET /api/health` → `modelClients` 段（连接级累计 + 全局累计）；run `metrics.modelClient`（connectionId + reused） |

## 3. 变更文件

- 新增 `src/apps/server/src/runtime/modelClientCache.ts`（缓存 + 指纹 + 引用计数 + 指标）
- `src/apps/server/src/app.ts`（缓存工厂、配置路由失效、health 指标、onClose dispose、createRuntime 接入）
- `src/apps/server/src/runtime/agentRuntime.ts`（`modelClient` 指标透传）
- `src/packages/shared/src/index.ts`（`ProviderStatus.modelClients`、`AgentRunMetrics.modelClient` 类型）

## 4. 测试

- 新增 `src/apps/server/test/modelClientCache.test.ts`（12 项：复用/并发/配置修订/失效/延迟释放/指标/指纹）
- 新增 `src/apps/server/test/modelClientApi.test.ts`（6 项：连续与并发 run 复用、修订/删除/重载/切换连接防复用）
- server 全量 162/162 通过

## 5. 业界依据

AI SDK / OpenAI SDK provider client 为无状态工厂产物，可跨请求共享；
配置指纹散列化避免密钥进日志（同 tool cache 的 SHA-256 键惯例）。
