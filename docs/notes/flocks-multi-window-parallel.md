# Flocks 多窗口 Agent 并行运行机制（精简版）

> 源文档：`.reasonix/attachments/clipboard-20260807-220631.591732-000001.md`（调研日期 2026-08-07，Flocks Python/FastAPI/asyncio 源码级解析 + TypeScript 移植方案）

## 1. 一句话结论

Flocks 的"多窗口 agent 并行"是**单进程、单事件循环（asyncio）上的多协程并发**，非多进程/多线程：

- **窗口间**：每个 WebUI 窗口 = 独立 `Session`，各自消息触发 `SessionLoop.run()`，以独立协程并发运行；用 `contextvars` 隔离"当前 session"，per-session keyed lock 消除无关会话锁竞争。
- **窗口内**：同一 assistant turn 模型发出多个前台 `delegate_task`/`task` 子代理调用时，作为**兄弟 asyncio.Task 并发启动**（`asyncio.create_task`），步结束前统一 `asyncio.gather` 汇合。
- **工具级**：子代理本身是"运行完整子 SessionLoop 的工具"，并行 = 多个 session loop 协程并发 + 事件回流。

## 2. 三层并行模型

```
WebUI 窗口 A/B/C ——各自 SSE 订阅 + POST /api/session/run
        │
        ▼
单进程 FastAPI + asyncio 事件循环
  asyncio.create_task(SessionLoop.run(A))  ...(B)...  ...(C)
        │
  每步 step loop：provider 流式生成 → StreamProcessor
        │  收到 tool-call（delegate_task/task 前台）
        ▼
  asyncio.create_task 并发启动 ──► SessionLoop.run(子会话1/2/3)
        │                              （drain: gather 汇合）
        ▼
  EventBroadcaster → 每客户端独立 EventQueue（SSE，慢客户端压缩）

并行层级：
  L1 窗口间：多 Session loop 协程并发（无共享可变状态，contextvars 隔离）
  L2 窗口内：同回合多 subagent 工具调用并发（create_task + gather）
  L3 排队任务：TaskQueue(max_concurrent=4) + asyncio.Semaphore 限并发
```

三层可叠加：subagent 是独立 Session，内部还能再递归派生子代理（各子会话有独立 `_active_loops` 条目与生命周期锁）。

## 3. 原理详解

### 3.1 窗口间并行

- **入口**：`flocks/server/routes/agent.py:846-861` —— `asyncio.create_task(_run_loop())` 不阻塞请求协程；`SessionLoop.run`（session_loop.py:533）为主入口。
- **幂等/防重入**：`SessionLoop.is_running(session_id)` 查 `_active_loops: Dict[str, LoopContext]`（session_loop.py:176）；已在运行则返回 `action="queued"`，新消息持久化后由活跃 loop 下步拾取（session_loop.py:569-583）；注册 `:696` / 退出 `del :744`。天然支持多会话同时运行。
- **准入**：`Session.get_by_id` + `status=="active"` 校验。
- **contextvars 隔离**：`Session._current_var: contextvars.ContextVar`（session.py:162-165，PEP 567）。值绑定协程/Task 执行上下文（Task 创建时 `copy_context()` 快照），多窗口交错 await 互不污染；读写经 `Session.set_current_session`/`get_current_session`（session.py:1600-1611）。
- **keyed lock**：全局仅 `_tree_lock`（串行化会话树拓扑变更）；普通写用 per-session lock —— `_lifecycle_locks: weakref.WeakValueDictionary[str, asyncio.Lock]`（session.py:170-178），会话 A 持锁等待不影响 B。
- **step loop**：`SessionRunner`（session/runner.py）每步：取消息 → provider 流式生成 → StreamProcessor 处理流事件 → 执行工具 → 循环至 finish=stop/end；`SessionLoop.run` 创建 Runner 并 `await runner._process_step(...)`（session_loop.py:1240-1260）。

### 3.2 窗口内并行（同回合多 Subagent）

**并行判定**（stream_processor.py:1540-1551 `_should_run_tool_call_parallel`）：

```python
tool_name in {"delegate_task", "task"}
    AND run_in_background is not True
    AND (subagent_type or category or session_id 存在)
```

**并发启动**（stream_processor.py:1553-1575 `_start_parallel_tool_call`）：每个符合条件的事件立即 `asyncio.create_task(_handle_tool_call)`，存入 `_parallel_tool_tasks: Dict[str, asyncio.Task]`（:182），`add_done_callback` 清理 —— **不等模型回复收完就并发执行**。

**汇合**（stream_processor.py:1577-1582 `drain_parallel_tool_calls`）：`asyncio.gather(*tasks, return_exceptions=True)`；runner.py:3542-3545 在流结束、发出 FinishEvent 后、把工具结果喂给下一轮 LLM 前调用。

> 语义：**并发启动，同步汇合**。并行只在同一回合兄弟工具调用之间；跨 step 仍串行（每步等 gather 完成）。

**subagent 工具内部**（flocks/tool/agent/delegate_task.py:392）：
1. 权限确认 `ctx.ask(permission="delegate_task", ...)`（:425-430）
2. 去重：同 agent+描述已委托则复用上次结果（:434-443，防循环委托）
3. 解析 skills / model 覆盖
4. **创建子 Session** `Session.create(parent_id=父会话, category="task", ...)`（:510-525）+ 写入用户消息
5. `ActivityForwarder` 把子会话活动事件转发到父会话 SSE（:534-540）→ WebUI 渲染 DelegateTaskCard
6. 同步执行 `_run_subagent_with_hooks` → `await SessionLoop.run(child_session_id)`（:69，工具函数 async；作为兄弟协程之一在事件循环上交错）
7. 收尾：HookPipeline.run_subagent_start/stop（:59-165）

关键：**子代理是完整会话**（独立 session_id/历史/锁/`_active_loops` 条目），可递归派生子代理 → 天然递归并行与状态隔离。

### 3.3 事件总线与子代理事件转发

- `EventBroadcaster`（server/routes/event.py:232）单例，`_clients: dict[EventQueue, AuthUser]`；每 SSE 客户端（每窗口/TUI）订阅得独立 `asyncio.Queue`（subscribe :268-273）。
- `publish`（:280-310）：从事件提取 `sessionID`（`_event_session_id` :57-89）→ 加载 Session → 只推给 `SessionPolicy.can_read` 的客户端。
- 慢客户端保护：`EventQueue` 相邻快照合并 + 丢弃旧快照 + 恢复标记（:154-217）。
- `ActivityForwarder`（session/features/activity_forwarder.py）：子会话事件（文本增量/工具/状态）包装发往父会话 → 前端"主代理 + N 并行子代理卡片"。
- SSE 端点：`GET /event`（:512-539），`StreamingResponse` + 30s 心跳。

### 3.4 任务队列并发上限

- `TaskQueue(max_concurrent=4)`（flocks/task/queue.py:14-40）：dequeue 时 `_running_ids >= max_concurrent` 返回 None，否则 `claim_next_queue_execution`。
- 后台任务另用 `asyncio.Semaphore(max_concurrency)`（flocks/task/background.py:85）。
- 系统级护栏：无论多少窗口/任务，同时运行排队任务不超上限，防 FD 耗尽与 SQLite 写竞争（kafka/manager.py:63、syslog/manager.py:42）。

## 4. 文件地图

| 模块 | 职责 | 并行要点 |
|---|---|---|
| server/routes/agent.py | agent 运行入口 | `asyncio.create_task(_run_loop())` :861 |
| server/routes/session.py | 会话 REST + 运行 | 多窗口 REST 面 |
| server/routes/event.py | SSE 广播 | 单例 + 每客户端独立 EventQueue |
| session/session.py | Session 元数据 | contextvars 隔离 :162；keyed lock :173 |
| session/session_loop.py | 会话主循环 | `_active_loops` :176；防重入 :569；step 循环 :1240-1260 |
| session/runner.py | 单步执行 | `drain_parallel_tool_calls()` :3545 |
| session/streaming/stream_processor.py | 流事件处理 | 并行判定 :1540；启动 :1553；drain :1577 |
| tool/agent/delegate_task.py | subagent 工具 | 子 Session :510-525；Forwarder :534 |
| session/features/activity_forwarder.py | 子代理事件转发 | 子会话 → 父会话回流 |
| task/queue.py | 排队并发控制 | max_concurrent=4 |
| task/background.py | 后台信号量 | asyncio.Semaphore |
| webui/src/features/session-chat/ | 前端聊天 + SSE | sseRouting.ts 按 sessionID 路由到窗口 |

**调用链**：窗口发消息 → `POST /api/session/.../run` → `SessionLoop.run(A)`（防重入 → 注册 `_active_loops[A]`）→ while step：`SessionRunner._process_step`（流式生成 SSE → StreamProcessor 收 tool-call → 前台 delegate_task？`create_task` 并发启动多个子 `SessionLoop.run`，各自回流事件 → FinishEvent → `drain_parallel_tool_calls()` gather）→ 工具结果喂回 LLM，进入下一步（串行）。

## 5. 设计约束与取舍

1. **不用多进程/多线程**：单事件循环内并发，无共享内存竞争、无 GIL 问题（I/O 密集）；代价是 CPU 密集子任务阻塞事件循环。
2. **前台优先，后台禁用**：`run_in_background` 在 schema 层与工具内部（delegate_task.py:407-415）双重拒绝；并行必须用"同回合多个前台兄弟调用"表达，后台语义由 TaskQueue 承担。
3. **每会话串行，会话间并行**：同 session 防重入锁（is_running → queued）杜绝同窗口乱序；不同 session 完全并行。
4. **subagent 是完整会话而非函数**：换递归并行/状态隔离/独立 UI 卡片；代价是完整生命周期开销（权限/持久化/钩子/标题）。
5. **dedup 防循环委托**（delegate_task.py:434-443）：相同委托幂等。
6. **慢客户端背压**：SSE 队列快照合并 + 丢弃 + 恢复标记。

## 6. TypeScript 移植指南

### 6.1 概念映射

| Flocks（Python） | TypeScript | 说明 |
|---|---|---|
| asyncio + create_task | Promise / 未 await promise | 同构：单线程异步并发 |
| asyncio.gather | Promise.all | 汇合 |
| contextvars.ContextVar | AsyncLocalStorage（node:async_hooks） | 见 6.2 陷阱 |
| per-session keyed lock | `Map<string, Promise>` / async-mutex | 每会话一把锁 |
| `_active_loops` | `Map<string, RunningLoop>` | 活跃 loop 注册表 |
| `_parallel_tool_tasks` | `Map<string, Promise>` + 结束前 Promise.all | 兄弟工具并发 |
| EventBroadcaster + EventQueue | EventEmitter + 每客户端 ReadableStream(SSE) | 事件推送 |
| TaskQueue(max_concurrent=4) | p-limit / p-queue | 并发上限 |
| delegate_task 工具 | 自定义 delegateAgent 工具 | 子代理 |
| SessionPolicy.can_read 路由 | SSE 房间（room）过滤 | 按会话过滤 |

### 6.2 AsyncLocalStorage 正确用法（含陷阱）

核心模式：`run()` 包住每个会话的整个执行体；任意深处 `sessionStorage.getStore()` 读当前会话。

**⚠️ 必须用 `run()`，不要用 `enterWith()`**：
- `enterWith(store)` 写"当前共享父上下文"，多个并发任务在 await 处交错时 last-write-wins，交错任务读到同一个错误值（经典串扰）。
- `run(store, fn)` 每次创建全新独立上下文，fn 返回自动恢复，并发互不污染。
- Python 端 `ContextVar` + Task 创建时 `copy_context()` 天然无此坑，TS 必须显式选对 API。

```ts
// ❌ enterWith：并发 worker 下上下文串扰
queueWorker.on('job', (job) => { sessionStorage.enterWith({ sessionId: job.data.sessionId }); return processJob(job); });
// ✅ run：每个 job 独立上下文
queueWorker.on('job', (job) => sessionStorage.run({ sessionId: job.data.sessionId }, () => processJob(job)));
```

其他注意：浏览器端无 AsyncLocalStorage（Node/Bun/Deno 可用），须显式传 sessionId；EventEmitter 监听器/setTimeout 回调可能脱离原上下文，需 `AsyncResource.bind()` 或回调内重新 `run()`；Worker 线程/子进程不共享上下文。

### 6.3 并行工具调用（框架默认已支持）

- **LangChain.js / LangGraph**：`AgentExecutor._call` 与 `ToolNode` 均对同回合所有 tool_calls 做 `Promise.all`（langchain exec.ts、langgraph-core tool_node.ts）。OpenAI parallel function calling 语义：模型回复带 `tool_calls: [...]` 数组 → 框架自动并发执行。
- **Vercel AI SDK**：`generateText`/`streamText` 的 `tools` 对象天然并行（多个 `execute` 自动 Promise.all）；多步循环用 `stopWhen: isStepCount(N)` 或 `ToolLoopAgent`；`onToolExecutionStart/End` 对应 Flocks 事件发布；`streamText` + `useChat`（@ai-sdk/react）即流式聊天 + 工具可视化。
- **裸 OpenAI SDK**：底层 `tool_calls: ChatCompletionMessageToolCall[]`，自己 Promise.all；建议优先用 A/B。

### 6.4 子代理并行两种模式

- **模式 1：LangGraph Send API**（fan-out/map-reduce，结构化并行）：`new Send('research', { subject })` 动态扇出，同一 super-step 并行，fan-in 归并。要点：并行节点写追加型 key（`reducer: concat`），勿并发覆盖标量；`max_concurrency` 节流；默认 recursion_limit 25 个 super-step。
- **模式 2：工具型 Subagent**（动态、LLM 驱动委托，最贴近 Flocks）：把"运行子代理"封装成普通 tool（如 `delegate_task`），主代理对话中动态决定调用数量；`runSubagent` 内部 `sessionStorage.run({ sessionId: childId, parentId }, () => agentLoop(...))` 创建独立上下文执行完整子会话循环 —— 与 `SessionLoop.run(child)` 同构；框架 Promise.all 承担并发。

选型：结构化可预测并行（多路调研）→ Send API；动态对话驱动委托 → 工具型 subagent；可组合。

### 6.5 事件流（SSE）

- 服务端：EventEmitter 广播 + `Map<sessionId, WritableStream>`，`GET /event` 设 `Content-Type: text/event-stream` + `no-cache`，30s 心跳，断开清理。
- 前端：每窗口一个 `EventSource('/event?sessionId=...')`，按 `event.properties.sessionID` 路由渲染（对应 webui sseRouting.ts）。
- 备选：WebSocket（双向）、LangGraph `stream_mode` + ReadableStream。

### 6.6 mini-flocks.ts 最小骨架（要点）

- `sessionStorage.run({ sessionId }, ...)` 包住主会话循环 → 窗口间并行 = `Promise.all([runMainSession('win-A', ...), runMainSession('win-B', ...)])`。
- `delegate_task` 工具 `execute` 内调用 `runSubagent(agentType, prompt, sessionStorage.getStore()?.sessionId)`；`runSubagent` 内 `sessionStorage.run({ sessionId: childId, parentId }, ...)` 递归。
- 主循环用 `ToolLoopAgent({ model, tools: { delegate_task, ... }, stopWhen: isStepCount(6) })`（对应 step loop）。
- 事件用 `EventEmitter` 广播 `subagent.start/stop`、`session.finish`。

对照：`sessionStorage.run` ↔ `ContextVar`；`Promise.all(windows)` ↔ 多个 `asyncio.create_task(SessionLoop.run)`；`ToolLoopAgent+isStepCount` ↔ step loop；delegate_task 工具 + 框架 Promise.all ↔ StreamProcessor 并行启动；`runSubagent` 内 run ↔ delegate_task.py 内 `SessionLoop.run(child)`；EventEmitter ↔ EventBroadcaster。

## 7. 参考资料（源）

- PEP 567 Context Variables：https://peps.python.org/pep-0567/
- Node.js 异步上下文（AsyncLocalStorage/AsyncResource）：https://nodejs.org/api/async_context.html
- LangChain.js AgentExecutor 并行工具调用：https://github.com/langchain-ai/langchainjs/blob/main/langchain/src/agents/executor.ts
- LangGraph.js ToolNode：https://github.com/langchain-ai/langgraphjs/blob/main/libs/langgraph-core/src/prebuilt/tool_node.ts
- LangGraph.js Send API：https://langchain-ai.github.io/langgraphjs/reference/classes/langgraph.Send.html
- LangGraph 并行节点最佳实践：https://forum.langchain.com/t/best-practices-for-parallel-nodes-fanouts/1900
- Vercel AI SDK Call Tools in Parallel：https://ai-sdk.dev/cookbook/node/call-tools-in-parallel
- Vercel AI SDK ToolLoopAgent/streamText/stopWhen：https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent
- AsyncLocalStorage enterWith 串扰分析：https://aidevhub.ai/blog/2026/06/12/asynclocalstorage-enterwith-concurrency-crosstalk/
