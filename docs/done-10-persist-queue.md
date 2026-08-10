# 有界异步持久化队列（Issue #10）— 实施记录

日期：2026-08-11
状态：已完成

## 1. 背景与目标

父 issue #1 用户故事 30/31：逐事件持久化移出 SSE 与工具执行热路径，通过有界、
有序、异步批处理队列落盘；run 内事件顺序保持；队列延迟/批写入/饱和/失败/排空
可观测；run 完成与服务器关闭使用有界排空语义，关键记录（审批/工具/审计）不静默丢失。

## 2. 定稿设计

| 决策 | 定稿 |
|---|---|
| 队列模型 | 每次 run 一个 FIFO 有界队列 + 单消费者（顺序保证），flush 由批大小阈值或 `flushIntervalMs` 窗口触发 |
| 有界背压 | 队列满时入队等待至多 `saturationWaitMs`（类比 Kafka `max.block.ms`），超时以失败呈现（指标 + run 审计状态），不静默丢弃 |
| 有界排空 | run 完成与服务器关闭执行 drain，超时（`drainTimeoutMs`）显式报告 `drainTimedOut` + `remainingOperations`，剩余操作继续后台完成 |
| 读路径 | `listStateMarkers` 与 `commitRunCompletion` 保持直接等待（不入队） |
| 指标 | `metrics.persistence` 扩展：queueWaitDurationMs / batchWriteCount / batchWriteDurationMs / maxDepth / saturationCount / drainDurationMs / drainTimedOut / remainingOperations |
| 配置 | `SECOPS_PERSIST_QUEUE_CAPACITY`(512) / `SECOPS_PERSIST_BATCH_SIZE`(32) / `SECOPS_PERSIST_FLUSH_INTERVAL_MS`(20) / `SECOPS_PERSIST_DRAIN_TIMEOUT_MS`(5000) / `SECOPS_PERSIST_SATURATION_WAIT_MS`(1000) |
| 服务器关闭 | `PersistQueueRegistry` 注册活跃 run 队列，Fastify onClose 统一有界排空 |

## 3. 变更文件

- 新增 `src/apps/server/src/runtime/persistQueue.ts`（有界队列 + 背压 + 批处理 + 排空 + 注册表）
- `src/apps/server/src/runtime/agentRuntime.ts`（persist 改为入队；drain；指标填充）
- `src/apps/server/src/config.ts` + `src/.env.example`（队列配置）
- `src/apps/server/src/app.ts`（registry 创建与 onClose 排空）
- `src/packages/shared/src/index.ts`（`AgentRunMetrics.persistence` 扩展）

## 4. 测试

- 新增 `src/apps/server/test/persistQueue.test.ts`（11 项：异步入队/顺序/批大小/饱和背压/失败不中断/有界排空/指标）
- `agentRuntime.test.ts` 新增 2 项集成测试：run 内事件写入顺序（含审批/工具/审计/消息/终止事件的 FIFO 顺序）、队列指标
- server 全量 162/162 通过

## 5. 业界依据

tokio `mpsc::channel(capacity)`：有界通道满时 send 等待（背压）、单 receiver 保证顺序、
clean shutdown = close 后排空到空；Kafka producer `buffer.memory` + `max.block.ms`：有界缓冲 + 有界阻塞。
