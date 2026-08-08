# Flocks 工具调用机制技术设计文档（精简版）

> 源文档：`.reasonix/attachments/clipboard-20260807-220631.609061-000003.md`（v1.0，2026-08-07；后端全链路：注册→Schema 注入→流式执行→结果回写；前端：SSE 通路/工具卡片/思考折叠/ProcessGroup/打字机。行号以当时 HEAD 为准）

## 1. 架构总览

"注册中心 + 流式事件驱动"：前后端经 SSE 单向推送消息部件（`part`）状态机。

```
后端 (flocks/)
 启动: ToolRegistry.init() ── _register_builtin_tools()（装饰器）
                          ├─ _register_dynamic_tools()
                          └─ _load_plugin_tools()（YAML/Python/MCP）
 每轮: runner.py 选工具 → 构建 OpenAI function schema 注入 LLM
 LLM 流式返回 tool_calls delta
 核心: stream_processor._handle_tool_call()   ← 边流式边执行
   ├─ 去重 / Doom Loop 检测 → HookPipeline.run_tool_before（可 block）
   ├─ 沙箱策略检查 → ToolRegistry.execute()
   │    ├─ execution_mode 校验 / device 解析 / 设备凭证激活
   │    └─ Tool.execute() → schema 预检 → handler → 输出截断
   └─ HookPipeline.run_tool_after
 结果: ToolPart 状态机持久化 + 发布 message.part.updated (SSE)
        │ SSE
        ▼
前端 (webui/)
 useSSE.ts 共享 EventSource → sseActions.ts 路由（sessionID 过滤）
 → SessionChat.tsx reducer: updateMessagePart 就地合并
 → ChatMessageBubble (memo 自定义比较)
   ├─ ChatToolPart: <details> 卡片 + 状态徽章 + 输入脱敏
   ├─ reasoning part: useReasoningToggle 折叠 + 首句预览
   └─ ProcessGroup: 中间过程聚合折叠 (localStorage 持久化)
```

设计要点：
1. **边流式边执行**：收到 `ToolCallEvent` 立即执行工具，不等 LLM 流结束（stream_processor.py:474 注释——与旧版"流结束后批量执行"的核心差异）。
2. **统一注册中心**：`ToolRegistry` 单例持有全部工具，执行入口唯一（`ToolRegistry.execute`），天然形成权限/设备/熔断统一网关。
3. **前后端状态契约**：`ToolPart.state` 为契约对象，后端状态机（pending→running→completed/error）经 SSE 推送，前端按 `part.id` 就地合并，渲染层只认状态。

## 2. 后端：工具注册与加载

### 2.1 注册中心

`ToolRegistry`（registry.py:619）进程内单例：
```python
_tools: Dict[str, Tool] = {}          # 名称 → Tool 包装
_enabled_defaults: Dict[str, bool]    # 工厂默认 enabled（配置重置用）
_revision: int                        # 工具集变更版本号（会话缓存失效）
_failure_state: Dict[str, Dict]       # 连续失败状态（熔断）
```
- `register()`（:660）唯一写入路径，快照 `enabled_defaults`；`revision()` 变更时调 `Agent.invalidate_cache()` 失效 agent 提示缓存（:758）。
- `Tool`（:468）= `ToolInfo`（name/description/parameters/schema/source/native/enabled）+ `handler`（`async (ctx, **kwargs) -> ToolResult`）。

### 2.2 三种注册来源

| 来源 | 机制 | 位置 |
|---|---|---|
| 内置 | `@ToolRegistry.register_function(...)` 装饰器 | registry.py:771（装饰器）、:1635（批量） |
| 插件（YAML/Python/MCP） | `PluginLoader.load_extension("TOOLS")` + `discover_python_tool_sources()` | registry.py:1191 |
| 动态模块 | `_register_dynamic_tools()` | registry.py:2044 |

YAML 工具编译（tool_loader.py）：`yaml_to_tool()`（:576）；按 handler 类型分发 HTTP（`_build_http_handler` :339）/脚本/执行类；参数 schema 归一化（JSON Schema ↔ ToolParameter，`_normalize_input_schema`/`_json_schema_to_params` :217/:258）；密钥解析 `_resolve_secrets()`（:176）不在 schema 暴露。

MCP 工具：名以 `__mcp_` 前缀标记，`normalize_declared_tool_names()`（agent/toolset.py:61）后缀匹配展开。

### 2.3 Agent 工具集解析

`resolve_agent_initial_tools()`（agent/toolset.py:100）：① 显式 `tools` 列表 → 归一化（缺失工具 debug 级跳过，不阻塞加载）；② 遗留 `permission` 配置 → `PermissionNext.evaluate` 求值；③ 均未声明 → 空集（默认更严格，只给 always-load）；④ `rex` 特例：raw_tools 空时获得全部内置工具（:108）。

## 3. 后端：Schema 注入与 LLM 调用

- **每轮构建**（runner.py:2300）：对 selected_tool_infos 逐个 `_annotate_with_provider_version`（服务/厂商版本注入 description，:2306）→ `schema.to_json_schema()` → `{"type":"function","function":{name,description,parameters}}`。
- **缓存**：按 `(agent, selected_tool_infos, text_tool_call_mode)` 生成 cache_key（runner.py:2284），命中深拷贝返回。
- **Provider 流式解析**：各 SDK 统一把 delta 累加为结构化 tool_calls —— OpenAI 系按 `tool_call index` 分组拼接（provider/sdk/openai.py:217、openai_base.py:1109）；Anthropic 从 `input_content_block_delta` 累积 `input_json_delta`（anthropic.py:221）；Google `functionCall` 部分解析（google.py:311）；Azure 与 OpenAI 一致（azure.py:206）。参数 JSON 是**流式片段**，由累加器保证完整后再执行（后端 tool_accumulator.py；前端仅展示）。

## 4. 后端：流式执行链路

### 4.1 入口 `_handle_tool_call`（stream_processor.py:474）完整顺序

```
1. Doom Loop 防护检查        → 命中跳过
2. tool_call_id 幂等检查     → 已 completed/error 跳过
3. 非法工具名("invalid")     → 构造参数解析错误 ToolPart，直接 error
4. 状态置 running + 持久化 ToolPart + 发布事件
5. Doom Loop 检测（同参数连续 ≥3 次 → _stop_tool_processing）
6. tool_start_callback（CLI 展示）
7. HookPipeline.run_tool_before → 可改写 input / block
8. _resolve_sandbox_meta     → 沙箱策略，blocked 则返回错误
9. ToolRegistry.execute      → 真正执行
10. HookPipeline.run_tool_after（按 completed/blocked/error）
11. 状态置 completed/error + 持久化 + 发布事件
```

### 4.2 Doom Loop 防护（stream_processor.py:622）

- `DOOM_LOOP_THRESHOLD = 3`（session/core/defaults.py:26）；取当前 assistant 消息最后 3 个 part，全部是**同名工具、同输入 JSON、非 pending** → 判定循环（:630-639）；触发后 `_stop_tool_processing=True` 跳过后续调用，让模型带完整上下文进下一步。

### 4.3 `ToolRegistry.execute`（registry.py:865）统一网关

```
工具存在性 → execution_mode 校验（is_tool_allowed / tool_call_denial_reason）
→ device 工具: _resolve_device_target 解析 device_id（失败提示 device_manage(action='list') 确认）
→ 全局 enabled + 每设备 enabled 覆盖（get_device_tool_enabled）
→ activate_device_credentials(device_id) 激活设备密钥（失败→设备未找到/已禁用）
→ tool.execute(ctx, **kwargs)
→ 失败熔断: _record_failure（连续 3 次同错误自动禁用）
```

### 4.4 `Tool.execute` 内部（registry.py:479）三道防线

1. **别名重映射** `_remap_schema_kwargs`（:500）：大小写/分隔符漂移纠正（file_path↔filePath）
2. **未知参数拦截**（:511）：不在 schema 中直接返回带 `schema_precheck` 元数据的错误，提示 allowed/required/aliases
3. **必填校验**（:538）
通过后 `_coerce_params`（:320）按类型转换，再调 `handler(ctx, **coerced_kwargs)`。

### 4.5 输出截断（registry.py:573）

非字符串先 JSON 序列化 → `truncate_output`（tool/truncation.py）超限截断落盘，`ToolResult.metadata.output_path` 指向文件、`result.truncated=True`；截断阈值感知 agent：`has_task_tool = "task" in agent_name.lower()`（registry.py:586）。

### 4.6 元数据回调与 Langfuse

- `_make_metadata_cb`（stream_processor.py:745）：执行期间异步持久化 + 发布运行态元数据（sessionId/title 等），`mark_finished()` 保证不覆盖终态。
- Langfuse span：`Tool.execute.{name}`（:714），带 session/message/call_id/step 上下文。

## 5. 后端：执行守卫（Hook / 沙箱 / 熔断）

- **Hook 管道**（hooks/pipeline.py）：`run_tool_before`（:277）可改写输入（`hook_ctx.input.tool.input` 回写）或返回 `decision="block"`+reason 拦截（stream_processor.py:687-692）；`run_tool_after`（:1218）按 completed/blocked/error 回调；被 block 的调用产生 `ToolResult(success=False, metadata={"blocked_by_hook": True})`，前端展示 blocked。
- **沙箱策略**（`_resolve_sandbox_meta`，stream_processor.py:1273）：按 tool_name 解析 extra + blocked 标志；blocked → `metadata={"sandbox": True, "blocked_by_policy": True}`；`tool_extra` 注入 execution_mode/workspace_dir/model 等（:850）。
- **失败熔断**（registry.py:1895-1986）：`_failure_disable_threshold=3`；`_failure_key(tool_name, params, error)` 归一化参数指纹（:1936）；同指纹连续失败 3 次 → 自动 `enabled=False`，结果附 `disabled:True, disabled_reason:"repeated_error"`，错误信息追加禁用说明（:1002-1008）；仅统计可计数错误（排除超时等），成功即重置。

## 6. 后端：结果回写与状态机

- **ToolPart.state**：`pending → running → completed | error`（hook/sandbox block 等价 error 语义）；每阶段 `Message.store_part()` 持久化（Postgres）+ `event_publish_callback("message.part.updated", {part})` 推 SSE；时间戳 `state.time = {start, end}`，前端渲染耗时 `(end-start)/1000`。
- **中断**：`asyncio.CancelledError` 走 `_finalize_interrupted_tool_call`（stream_processor.py:1117），终止运行态元数据异步任务避免覆盖终态；前端 abort 经 `ToolContext.abort_event` 传 handler。
- **并发工具调用**：`_should_run_tool_call_parallel`（:1540）+ `_start_parallel_tool_call`（:1553）同消息内并发执行多个调用，`drain_parallel_tool_calls`（:1577）聚合等待。

## 7. 前端：SSE 数据通路

- **共享连接**（hooks/useSSE.ts）：多订阅者共享一条 EventSource（`sharedConnections` Map 按 URL 缓存，引用计数，无订阅者关闭，:139 `cleanupInactiveConnection`）；重连指数退避 + 随机抖动上限 30s（:127）；`server.events_dropped` 触发 `recoveryPending` 立即重连（:198），重连成功回调 `onReconnect` 补拉状态。
- **事件路由**（features/session-chat/sseActions.ts:52 `resolveSessionChatSSEAction(event, sessionId)`）：先按 `sessionID` 匹配过滤（多会话共享连接隔离）→ 归一化为判别联合 `SessionChatSSEAction`（message-part-updated/message-updated/message-removed/session-status/question-asked|replied|rejected/compaction-progress/context-usage-updated/session-error…）；未知事件 → `{kind:'ignore'}`（:167）。
- **状态合并**（SessionChat.tsx:2121 reducer）：`message-part-updated` → ① `isActiveToolPart`（running）加入 `activeToolPartIdsRef` 并 `isStreaming(true)`，否则移出（:2123-2130）；② `updateMessagePart(part, delta)` 按 `part.id` **就地浅合并替换**；③ `scrollToBottom()`。就地合并是性能关键：只替换变化 part，配合 memo 渲染避免整条消息重渲染。

## 8. 前端：工具调用卡片渲染

- **组件**（SessionChat.tsx:5646 `ChatToolPart`）：每个 `part.type==='tool'` 渲染 `<details>` 折叠卡片（:5896）：
```
<summary> [状态图标][语义化工具名][关键参数摘要]...[状态徽章][chevron] </summary>
详情区: todo 任务列表 / bash 命令+输出 / 运行中三点 pulse /
        输入参数 <details> 折叠 JSON（redactToolInput 脱敏）/
        输出 <details open> 绿色等宽 pre（max-h-48 滚动）/
        错误红框 / 耗时（右下角）
```
- **语义化展示**（components/common/toolPresentation.ts `resolveToolPresentation` :317）：`STATIC_LABEL_KEYS`（:14，50+ 内置工具名→i18n key，bash→"执行命令"、delegate_task→"委派任务"）；`ACTION_LABEL_KEYS`（:60，按 action/subcommand/operation 细分，lsp+goToDefinition→"查找定义"）；`buildDetail`（:214）提取文件路径/URL hostname（urlDetail）/查询词/workflow 名/patch 路径列表（patchPaths 正则解析 `*** Add File:`）；`getFileOperationDisplayName`（:182）文件操作显示文件名。
- **脱敏**：`redactToolInput`（:332）递归处理输入，key 命中 `SENSITIVE_KEY_PATTERN`（api_key|password|token|secret|authorization|credential|cookie 等，:14）值替换 `••••••`——**只在展示层脱敏，不改后端数据**。
- **状态徽章**（:5664 `statusConfig`）：pending→Clock/zinc/等待中；running→Loader2(spin)/sky/运行中；completed→CheckCircle2/green/已完成；error→XCircle/red/失败。
- **特殊工具定制**：delegate_task/task→`DelegateTaskCard`（子代理状态+输出汇总，:5652）；question→`QuestionTool` 交互式问答（有 pendingQuestion 时优先，:5757）；todo→任务列表（:5787）；bash→`ChatBashPayload`（:5816）；run_workflow→`buildRunWorkflowHeaderSummary`（toolStageSummary.ts:55，含 prepare/running 阶段标签，:5729）。
- **截断**：`TOOL_DISPLAY_MAX_LEN=120`（:5086），统一 `truncateToolDisplayText`。

## 9. 前端：思考过程折叠

- **状态管理**（hooks/useReasoningToggle.ts，78 行）：
```ts
const isReasoningDone = !!messageFinish || hasTextPart || hasToolPart;
// 思考进行中（尚无 text/tool 输出）→ 默认展开；思考结束 → 默认折叠
const fallback = isReasoningDone ? defaultExpanded : expandWhileActive;
return expandedByKey[partKey] ?? fallback;   // 用户手动状态优先
```
  1. **"思考是否结束"不看 thinking part 自身**，而看同消息是否已有 text/tool part（:45）——text/tool 出现即代表模型开始输出；
  2. `expandedByKey` 以 `part.id` 记用户手动展开/折叠，`togglePart` 取反（:64）；
  3. **思考中强制展开**：`activeTailPart` 命中时 `isThinking=true` → `isExpanded=true` 且按钮 disabled，图标换旋转 Loader2（SessionChat.tsx:4670-4687）。
- **两种渲染**（SessionChat.tsx:4666）：A. 独立思考块（非 processStep）：Brain 图标+圆角灰底按钮；折叠显示 `thinkingText.slice(0,80)+…`（:4736）；展开等宽字体 `max-h-52 overflow-y-auto`（:4744）。B. 流程步骤（processStep=true）：紧凑按钮行+“深度思考”；折叠显示 `getThinkingFirstSentence()` 首句（:4690）；展开左侧 `border-l` 时间线（:4701）。
- **流式思考文本**（StreamingReasoningText，:352，经 StreamingMarkdown.tsx:236 `useStreamingContent`）：新增内容按 **Unicode 字素簇** 切分（`Intl.Segmenter`，正确处理 emoji/组合字符，:191）；`requestAnimationFrame` 逐帧 drain（`getStreamingDrainBudget` :204——基线速率+积压线性加速，封顶每秒字素数/每帧上限）；累积剩余信用（fractional credit）跨帧滚动防突发跳帧；流结束取消挂起 rAF 直接应用最终内容（:287）。

## 10. 前端：中间过程聚合（ProcessGroup）

- **聚合算法**（SessionChat.tsx:4800 `renderDisplayParts`）：`collapseIntermediateSteps=true`（非用户消息）时——遍历 displayParts：reasoning/tool part（pending question 除外）→ 加入当前 processGroup；text part 且位于最后一个中间过程之前 → 归组（尾部文本归组）；遇 text/pending question → flush 当前组单独渲染；最后 flush。`isIntermediateProcessPart`（:4575）：reasoning（有可渲染文本）/tool（非 pending question）。组内每个 part 以 `processStep=true` 渲染为时间线步骤（:4794）。
- **ProcessGroupDetails**（:4362）：原生 `<details>`；summary：“过程 N 项” + 耗时徽章（`getProcessGroupDurationMs` + `useProcessElapsedClock` 每秒刷新实时计时，:339）；折叠状态**受控**：`processGroupOpenState`（`flocks:session:{sessionId}:processGroupsOpen`，localStorage 持久化，:1290）；三态合并（:4764）：`hasStoredOpenState ? stored : (defaultOpen || (openWhileActive && isActive))`——进行中默认展开，用户开合独立记忆。

## 11. 前端：流式打字机与渲染性能

- **Bubble 级 memo**（SessionChat.tsx:5938）：`ChatMessageBubble = memo(ChatMessageBubbleInner, custom)`——结构 props 快路径（isActive/showActions/collapseIntermediateSteps/processGroup 配置/editing/message.finish）；`parts.length` 变化才深入；`areChatMessagePartsRenderEqual`（sessionChatRenderEquality.ts）逐 part 浅比较（type/id/tool/state.status/input 引用/文本片段）——高频流式下只重渲染真正变化的 bubble。
- **渲染节流**：思考/文本走 `useStreamingContent` 的 rAF drain，SSE 高频 delta 不直接触发 React 渲染；耗时时钟独立 `useProcessElapsedClock`（1s 间隔）不与流式渲染耦合。

## 12. 关键代码索引

### 后端
| 职责 | 位置 |
|---|---|
| 注册中心/执行网关 | registry.py:619 / :865 / :479 |
| 内置工具装饰器 | registry.py:771 |
| 插件工具加载 | registry.py:1191 |
| YAML 工具编译 | tool_loader.py:576 / :339 |
| Agent 工具集解析 | agent/toolset.py:100 / :61 |
| Schema 构建注入 | session/runner.py:2300 |
| 流式执行核心 | stream_processor.py:474（_handle_tool_call）、:622（Doom Loop）、:1117（中断）、:1218（after hook）、:1273（沙箱） |
| Doom Loop 阈值 | session/core/defaults.py:26（=3） |
| Hook 管道 | hooks/pipeline.py:277（before）、:285（after） |
| 失败熔断 | registry.py:1945（_record_failure） |
| 输出截断 | tool/truncation.py（truncate_output） |
| Provider 流式解析 | provider/sdk/openai.py:217、anthropic.py:221、google.py:311、azure.py:206 |

### 前端
| 职责 | 位置 |
|---|---|
| 共享 SSE 连接 | hooks/useSSE.ts:150（connectShared）、:127（重连退避） |
| SSE 事件路由 | features/session-chat/sseActions.ts:52 |
| part 状态合并 | components/common/SessionChat.tsx:2121 |
| 工具卡片 | SessionChat.tsx:5646 |
| 语义化展示 | components/common/toolPresentation.ts:317、:332（脱敏） |
| 思考折叠 | hooks/useReasoningToggle.ts:21；SessionChat.tsx:4666、:352 |
| 中间过程聚合 | SessionChat.tsx:4800、:4362 |
| 折叠持久化 | SessionChat.tsx:1290（localStorage） |
| 打字机 | components/common/StreamingMarkdown.tsx:236、:204 |
| Bubble memo | SessionChat.tsx:5938 |

## 13. 端到端时序

```
用户发送消息 → [后端] runner.py 构建工具 schema → LLM 请求
→ [LLM] 流式返回 reasoning delta + tool_calls delta
→ [后端] reasoning part 推送 | tool_calls 累加完整后触发 ToolCallEvent
→ [前端] useReasoningToggle（思考中默认展开+打字机） | [后端] _handle_tool_call
   ├─ 去重 / Doom Loop / invalid 检查 → tool_before hook → 沙箱 → ToolRegistry.execute
   └─ 每阶段推送 message.part.updated（pending→running）→ completed/error 推送 + tool_after hook
→ [前端] reducer 就地合并 part → ChatToolPart 卡片刷新（running: Loader2 徽章+输入摘要；completed: 徽章+输出默认展开；error: 红框）
→ collapseIntermediateSteps 时聚合为 ProcessGroup（进行中默认展开时间线+实时耗时；结束后默认折叠，localStorage 记忆）
```

## 附录 A：前后端状态契约（SSE message.part.updated 的 ToolPart）

```jsonc
{
  "id": "part_xxx", "messageID": "msg_xxx", "sessionID": "ses_xxx",
  "type": "tool", "callID": "call_xxx", "tool": "bash",
  "state": {
    "status": "running",            // pending | running | completed | error
    "input": { "command": "ls -la" },
    "output": "...",                 // 仅 completed
    "error": "...",                  // 仅 error
    "title": "可选运行标题",          // metadata 回调填充
    "metadata": { "blocked_by_hook": true, "disabled": true },
    "time": { "start": 1750000000000, "end": 1750000001000 }
  }
}
```
要点：前端渲染**只依赖 state**，与执行逻辑解耦；`metadata.blocked_by_hook/blocked_by_policy/disabled` 是特殊语义标志（区分"被拦截"与"执行失败"）；输入/输出可能被截断（`metadata.output_path` 指向完整落盘文件），展示层不感知。

## 附录 B：设计权衡记录

| 决策 | 权衡 | 结论 |
|---|---|---|
| 边流式边执行 vs 流结束批量执行 | 前者响应快但并发管理复杂；后者简单但体验延迟 | 边流式边执行，配 Doom Loop + 幂等 + 并行调用（stream_processor.py:474） |
| 展示层脱敏 vs 执行层脱敏 | 展示层不改业务数据但依赖前端自觉；执行层更安全但侵入 handler | 展示层 `redactToolInput` 兜底，敏感 key 正则覆盖 |
| 原生 `<details>` vs 自研折叠 | details 免费获得键盘/无障碍语义，样式受限 | 全链路统一 `<details>` + 自定义 summary（chevron 旋转、list-none） |
| 单条共享 SSE vs 每组件一条 | 共享省资源，路由复杂度转移到 sseActions | 共享 EventSource + 引用计数 + sessionID 路由 |
| 思考折叠判定 | 依赖"有 text/tool part"而非 thinking 自身结束标记，兼容无结束事件的流 | useReasoningToggle 的 `isReasoningDone` 聚合三信号（finish/text/tool） |
