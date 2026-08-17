# 两阶段工具路由：按需进入 Deep Dive 原型 Spec

## 1. 现状
- `agentRuntime.run` 在 `useLayeredRouting` 下总是执行 Phase 1 (Triage) + Phase 2 (Deep Dive)。
- 两个阶段都通过 `runStreamPhase` 把 reasoning 和 text 流式转发给前端。
- 结果：用户每轮对话可能看到两次“模型思考”、甚至两次 assistant 文本；Phase 1 的中间文本可能误导模型自己（Deep Dive 会把它当历史上下文）。

## 2. 目标
- Deep Dive 只在“适合进入第二阶段”时执行。
- Phase 1 的 reasoning 和 tool-call 仍作为可折叠的过程事件展示。
- Phase 1 的 assistant 文本不作为最终回复展示；每轮用户只看到一个最终 assistant 消息。
- 若决策判定无需 Deep Dive，则把 Phase 1 产生的最终文本直接作为本轮唯一回复返回。

## 3. 业界类似产品/模式考察
| 产品/模式 | 做法 | 可借鉴点 |
| --- | --- | --- |
| OpenAI function calling / Assistants | 单循环，模型直接选择工具，不隐藏任何输出 | 工具是否加载由模型可见 schema 决定 |
| LangGraph / 状态机 agent | 路由节点由代码判定，模型输出只是状态 | 阶段跳转用确定性代码，不靠模型“自觉” |
| ReAct / AutoGPT | 单循环 think-act-observe | 输出和工具事件统一在一个时间线 |
| Claude Code / Codex plugin | 工具权限与子 agent 路由由框架控制 | 路由是框架能力，不注入系统提示词 |

结论：阶段路由应由代码确定性决策；是否进入 Deep Dive 不应让模型输出一个新变量来决定，否则会引入额外 token 和不可控的分叉。

## 4. 方案比较
### 方案 A：展示两个阶段的全部思考和中间文本
- 优点：透明度高，调试直接。
- 缺点：用户看到多个“最终答案”；Phase 1 中间结论会污染 Phase 2 上下文，误导后续推理。

### 方案 B：代码决策，Phase 1 文本隐藏，按需进入 Phase 2（本原型）
- 优点：用户只看到一个最终回复；路由确定性、可测试；省 token。
- 缺点：Phase 1 的最终文本若不满足需求，需要兜底再进入 Phase 2。

### 方案 C：引入模型输出变量（如 `needs_deep_dive`）决定是否进入 Phase 2
- 优点：模型可表达不确定性。
- 缺点：需要额外输出协议；分诊阶段会为了输出变量而额外思考；可靠性不如代码规则；与“工具路由”分层设计重叠。

### 推荐
方案 B：代码规则 + 保留模型上下文。规则简单可解释：
1. Phase 1 没有产生最终 assistant 文本 -> 必须 Deep Dive。
2. Phase 1 因 `tool-calls` 达到轮次上限 -> 必须 Deep Dive 继续。
3. Phase 1 推断出的 Deep Dive 工具集合相比 Triage 有新增工具 -> 进入 Deep Dive。
4. 否则直接发布 Phase 1 的最终 assistant 文本作为本轮唯一回复。

## 5. 原型实现
- `runStreamPhase` 增加 `streamText` 选项（默认 true）。
  - `false` 时，文本消息只在内部收集，不 `emit`、不 `persist`、不加入 `messages`。
- Phase 1 使用 `streamText: false`；reasoning 和 tool 事件照常流式输出。
- Phase 1 结束后计算：
  - `triageFinal = triageResult.finalAssistantMessage`
  - `inferredCategories = toolRouter.inferCategories(...)`
  - `decisionToolIds = toolRouter.getDeepToolIds(inferredCategories)`（不强制追加 sandbox-actions）
  - `hasNewTools = decisionToolIds.some(id => !triageToolIdSet.has(id))`
  - `shouldRunDeep = !triageFinal || triageResult.finishReason === "tool-calls" || hasNewTools`
- `shouldRunDeep === false` 时通过 `publishBufferedMessage` 把 `triageFinal` 以流式分片发布到前端，结束 run。
- `shouldRunDeep === true` 时进入 Phase 2，并在 Deep Dive 工具集中追加 `sandbox-actions` 以保证动作工具可达；Phase 1 文本不发布。
- `inferCategories` 同步收紧：shell/network/http/dns/curl 等已常驻 Triage，不再触发 sandbox-actions。
