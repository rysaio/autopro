# Flocks 平台技术文档：自定义页面 / 工具系统 / 技能与配置机制（精简版）

> 源文档：`.reasonix/attachments/clipboard-20260807-220631.601753-000002.md`（调研日期 2026-08-07，源码根 `C:\Users\Aa138\flocks\flocks`，所有引用为真实 文件:行号；未找到的实现已注明"未找到"）

## Part 1 — WebUI 契约页面体系（自定义页面）

### 1.1 总体设计

"文件即插件"：用户在 `~/.flocks/plugins/contracts/webui/` 写 React 页面源码，平台经 文件监听 → esbuild 打包 → SSE 热刷新 → 前端动态 import 挂载到 WebUI 侧栏或场景工作区。**无需重启、无需手写路由**。

```
~/.flocks/plugins/contracts/webui/
  <pageId>/                 # 单页
    manifest.json           # 页面声明
    src/index.tsx（export default Page）+ src/Page.tsx
    api/                    # 可选：routes.yaml + handlers.py
    dist/                   # 自动生成，禁止手改（page.js / meta.json / api-meta.json）
  <workspaceId>/            # 场景工作区（如 soc_ui）
    workspace.json + access/（数据契约插件）+ <page_dir>/
```

### 1.2 manifest.json 与 workspace.json

模型：`flocks/contracts/webui/models.py`
- `WebUIPageManifest`（:10-25）：`id/title/titleEn/route/icon/order/enabled/placement/entry/updatedAt`
- `WebUIWorkspaceManifest`（:28-46）：`id/version/title/titleEn/icon/order/enabled/placement/defaultPageId/sections`
- `WebUIWorkspaceSectionManifest`（:49-74）：`id/label/labelEn/pageIds/defaultPageId/contentPadding("comfortable"|"none")/themeOverride("light"|"dark")`

ID 校验（store.py:26-27,38-50）：页面 `^[a-z0-9][a-z0-9-]*$`；工作区 `^[a-z0-9][a-z0-9_]*$`。manifest 解析失败仅记日志返回 None（页面静默跳过不中断服务，store.py:69-82）；workspace section 二次校验：归一化 id、去重 pageIds、section 级 defaultPageId 自动插入 pageIds 首部（store.py:730-765）。

消费方：后端 `store.list_pages()/list_workspaces()` 生成导航；前端 `webuiContractWorkspaceSections.ts:47-92` 分组渲染，`contentPadding`→宿主 padding（WebUIContractWorkspaceHost/index.tsx:35-37）、`themeOverride`→`setTemporaryThemeOverride`（:68-80）。

示例（用户空间 soc_ui/workspace.json）：`placement:"sceneWorkspace"`，sections 如 `posture`（态势，soc-dashboard，dark/无 padding）、`operations`（告警运营，soc-overview+soc-alerts）。

### 1.3 构建链路（builder.py）

`WebUIPageBuilder.build`（builder.py:51-168）subprocess 调用 `webui/node_modules/.bin/esbuild`：

```
--bundle --format=esm --platform=browser --target=es2020 --jsx=automatic
--alias:react=shims/react.js --alias:react/jsx-runtime=shims/jsx-runtime.js
--alias:@flocks/webui-contract-sdk=shims/sdk.js
```

- 三个包名 alias 到 shims → 页面源码**只能 import react 与 SDK**（白名单依赖）
- 状态写 `dist/meta.json`（`WebUIPageBuildMeta`）：`status(idle|building|ready|failed)/hash(sha256[:16])/builtAt/error(≤4000字符)`；失败日志仅 500 字符（:113-126）
- 产物经 `GET /api/contracts/webui/pages/{page_id}/bundle.js` FileResponse 下发（server/routes/webui.py:274-287）
- 触发：REST `POST /build`、watcher 文件变更、启动 `reconcile_webui_pages`（bootstrap.py:43-83，按 bundle 缺失 / meta 非 ready / runtime 或 SDK import 不匹配 / src 比 bundle 新 判定重建）

### 1.4 文件监听与 SSE 热刷新（watcher.py）

watchdog `Observer` 递归监听 `~/.flocks/plugins/contracts/webui`：
- 事件分类（:132-187）：`workspace.json`/`manifest.json`→manifest_changed；`src/*.ts(x)/js(x)/css`→source_changed；`api/routes.yaml`/`api/*.py`→api_changed；目录删除→page_removed；点前缀目录忽略
- 0.8s threading.Timer 防抖合并（:198-210）；source→`builder.build()`；api→`asyncio.run_coroutine_threadsafe` 投递 `api_runtime.reload_page`（:212-252）
- SSE 发布（:32-41 → event.py:439-462）：`contracts.webui.pages.updated / build_failed / api_changed / api_failed / nav_changed`，全局广播；30s 无事件发心跳（event.py:471-509）
- 主循环注册（server/app.py:429-445）：`set_event_loop` → `reconcile_webui_pages` → `start_watcher`

### 1.5 运行时路由与渲染

- 后端：`server/routes/webui.py`（APIRouter，app.py:1271 挂 `/api`）提供页面 CRUD/构建/bundle/API 转发/导入导出
- 前端路由（webui/src/routes/index.tsx:163-164）：`contracts/webui/workspaces/:workspaceId/:pageId?` → `WebUIContractWorkspaceHost`；`contracts/webui/:pageId/*` → `WebUIContractPageHost`
- 页面加载（PageRuntimeHost.tsx:79-108）：GET page 详情（manifest+build+hash）→ `installWebUIContractPageRuntime(pageId)` 装全局 SDK（runtime.tsx:100-113）→ `GET bundle.js?v=hash` → Blob + 动态 `import()` 得 default 组件（runtime.tsx:115-133）→ 订阅 SSE `/api/event` 热刷新（PageRuntimeHost.tsx:114-138）
- 侧栏分组（Layout.tsx:649-711）：`home.after`→首页组（:666-672）；`sceneWorkspace|aiWorkbench`→sceneWorkspaces 折叠组（:651-659,686-694）；工作区弹层按 sections 渲染（:1296-1370）

### 1.6 页面专属后端 API 运行时（api_runtime.py）

**设计原则：不注册全局 FastAPI 路由，页面 API 全部收敛到 `/api/contracts/webui/pages/<pageId>/api/*`。**

routes.yaml（:206-222）：
```yaml
routes:
  - method: GET
    path: /stats
    handler: handlers.get_stats
    timeoutMs: 30000   # clamp 1–30000
```

机制：
- handlers 用 `importlib.util.spec_from_file_location` 加载；`_create_guarded_import` 替换 `builtins.__import__` 只允许页面 api 目录内模块与标准库（:224-244,299-336）
- 路径校验：以 `/` 开头、不得含 `..`/`//`；方法白名单 GET/POST/PUT/PATCH/DELETE（:46-76,254-268）
- 请求体流式读取限 1MB；handler 经 `asyncio.wait_for` 限时执行（:143-165）；响应 JSON 限 2MB；失败写 `dist/api-meta.json`（:344-371）
- ctx 注入（:352-360）：`page_id/user/secrets/logger/cache`；`_SecretAccessor.get` → `flocks.security.get_secret_manager().get(key)`（:374-379）
- HTTP 挂载 + 鉴权（server/routes/webui.py:313-319）：`api_route("/contracts/webui/pages/{page_id}/api/{api_path:path}")` + `require_user(request)`
- handler 约定：`handler(ctx, request)`，返回 Response 或任意 JSON 可序列化对象

### 1.7 access 数据契约层

模型 `flocks/contracts/access/models.py`：`ContractOperation`(:39-56)/`Contract`(:58-64)/`Binding`(:66-82)/`WebUIContractPlugin`(:83-93，含 plugin_id/contracts/binding_resolver/adapter/response_pipeline/overlay_store)。

- **发现**：discovery.py:13-53 按 `ExtensionPoint(attr_name="CONTRACTS", subdir="contracts/access")` 扫描用户空间与项目 `.flocks/plugins/contracts/access/`，递归 max_depth=2
- **注册**：`ContractRegistry` 按 `(contract_id, version)` 去重；禁用字段 `bindingId/driver/sql/secret`（registry.py:10-23）
- **执行**（runtime.py:76-242）：校验 `contract.page_id == 请求 page_id` → PolicyContextResolver（租户/资产组策略）→ 查询走"策略计划→字段计划→查询计划→DriverProxy→adapter.normalize→response_pipeline"；变更走 MutationPipeline（OverlayStore + IdempotencyService）
- **OverlayStore**（pipeline.py:19-82）：进程内内存 KV，按 `(page_id, contract_id, version, entity_type, entity_id)` 存 OverlayEntry，mutation 版本号乐观并发（冲突 409）
- **HTTP**（server/routes/contracts.py:22-41）：`POST /api/contracts/webui/pages/{page_path}/access/{contract_id}/operations/{operation_name}`
- **前端**（runtime.tsx:91-98）：`api.contract(pagePath, contractId).operation(name, data)`
- 驱动仅支持 `builtin-jsonl` 与 `builtin-sqlite-json`（driver.py:35）
- 真实示例：`~/.flocks/plugins/contracts/webui/soc_ui/access/soc_alerts_operations.py`（PAGE_ID="soc-alerts"，CONTRACT_ID="soc.alerts.operations"）

### 1.8 SDK shims 与页面隔离

打包时 `react`/`react/jsx-runtime`/`@flocks/webui-contract-sdk` alias 到 shims 桩文件——桩不实现 React，从全局对象取运行时注入的实现：

```js
// shims/sdk.js
const sdk = globalThis.__FLOCKS_WEBUI_CONTRACT_SDK__;
if (!sdk) throw new Error('Flocks WebUI page runtime is not initialized (missing SDK).');
export const api = sdk.api; export const contract = sdk.api.contract;
export const Card = sdk.Card; export const useCurrentUser = sdk.useCurrentUser;
```

全局 SDK 安装（runtime.tsx:100-113）：宿主加载 bundle 前注入真实 React、jsx/jsxs、axios 派生的 api、Card、useCurrentUser。api 作用域（runtime.tsx:70-98）：`api.page.get('/stats')` → `/api/contracts/webui/pages/{pageId}/api/stats`；`api.contract(...)` → access 契约；axios 实例 `withCredentials: true` + 30s timeout（client.ts:40-47），自动携带 Cookie，**无需也不允许在页面代码放 Token**。

### 1.9 完整时序

```
文件落盘 → watchdog 归类 → 0.8s 防抖（watcher.py:94-115,132-210）
→ source 变更：esbuild 打包 dist/page.js+meta.json（watcher.py:223-241, builder.py:75-87）
  api 变更：reload_page 投递主循环（watcher.py:243-249）
→ SSE 广播 updated/build_failed/api_changed/nav_changed（watcher.py:32-41, event.py:439-462）
→ 导航：GET /api/contracts/webui/workspaces → Layout 分组（webui.py:156-158, Layout.tsx:651-711）
→ 路由：workspaces/:id/:page → WorkspaceHost；:pageId → PageHost（routes/index.tsx:163-164）
→ PageRuntimeHost：GET detail → 装 SDK → GET bundle.js?v=hash → blob import 组件
→ WorkspaceHost：sections 分组 + contentPadding/themeOverride 适配
→ 页面内：api.page / api.contract；useSSE 订阅热刷新
```

## Part 2 — Agent 工具系统与调用链路

### 2.1 三层认知模型

| 层 | 文件 | 职责 |
|---|---|---|
| Catalog（感知层） | tool/catalog.py | 只读描述全量工具目录：标签、匹配、always_load 元数据（:1-6） |
| Registry（注册/执行层） | tool/registry.py | `ToolRegistry._tools` 字典（:626），注册、门控、执行 |
| Session Callable State | session/callable_state.py + callable_schema.py | 决定每轮暴露哪些 schema。**注册 ≠ 可调用** |

`ALWAYS_LOAD_TOOL_NAMES = {"question", "tool_search"}`（catalog.py:21-24）——任何会话始终可用。

### 2.2 工具发现与注册

- 内置：`_register_builtin_tools()`（registry.py:1636）按 `_tool_groups` 表（:1647-1676）import `flocks.tool.file/code/web/agent/...`，模块内 `@register_function` 装饰器（registry.py:771-821）import 副作用注册，随后标 `native=True`
- 插件：`_load_plugin_tools()`（registry.py:1191）经 `PluginLoader.load_extension("TOOLS")` 扫描用户级 `~/.flocks/plugins/tools/` 与项目级 `.flocks/plugins/tools/` 的 `.py/.yaml/.yml`（递归 max_depth=2，排除 mcp/generated，registry.py:1623-1633）
- 刷新：`refresh_plugin_tools`（registry.py:1778-1851）带快照回滚；`ToolFileWatcher`（registry.py:2154）只监听 `tools/api|device|python` 下 yaml/py

### 2.3 tool_search 动态加载

- 会话创建只初始化"agent 静态声明工具 + always_load"（session.py:513-525；callable_schema.py:81-89），其余为**延迟工具（deferred）**
- 系统提示只给延迟工具目录清单，声明 schema 未加载、直接调用失败（runner.py:2174-2215）：`"The following deferred tools are available via tool_search. Their schemas are NOT loaded - calling them directly will fail with InputValidationError."`（实际抛错发生在模型提供商/OpenAI 兼容 SDK 层；flocks 源码仅见文案 runner.py:2207 与测试断言 tests/session/test_runner_step.py:1161）
- `tool_search` handler（tool_search.py:119-167）：`search_tool_catalog`（catalog.py:240-271）支持 `select:<name>` 精确匹配（:201-237）与关键词打分（:152-198，名称+120/规范名+140/描述/标签+75）→ `add_session_callable_tools`（callable_state.py:54-57）→ **下一轮 schema 构建生效**
- 设备工具附带候选设备提示（tool_search.py:35-88）

### 2.4 工具执行链路

流式处理器把 function call 组装成 `ToolContext` 后调 `ToolRegistry.execute`（stream_processor.py:870-893）：

```
Registry.execute（registry.py:866-1009）
 ├─ execution_mode 白名单（:887-919）
 ├─ source=="device" → pop device_id → _resolve_device_target（:929-948,1037-1085）
 │    单设备自动解析 / 多设备要求显式 id / 设备级禁用检查（:961-980）
 │    → activate_device_credentials 设置 ContextVar 覆盖（credential_context.py:129-163）
 └─ Tool.execute（registry.py:479-616）
     ├─ 别名重映射 _remap_schema_kwargs（:410-449）
     ├─ 未知参数拒绝（:511-535）
     ├─ 必填校验（:537-565）+ 类型强制 _coerce_params（:320-385）
     ├─ handler(ctx, **coerced_kwargs)
     └─ 输出自动截断 truncate_output（:573-594, truncation.py:87-191）
```

**输出防护**：默认 MAX_LINES=1000 / MAX_BYTES=100KB（truncation.py:31-32），完整内容落盘 workspace `tool-output/` 附 Grep/Read 提示；每轮按上下文窗口 30% 上限动态截断（runner.py:2584-2596, truncation.py:271-282）；`flocks.json` `toolOutput` 段配置 read 工具限长（tool_output_limits.py:83-109）。失败自动禁用：同参数同错误 3 次（registry.py:1946-1986）。

### 2.5 插件工具扫描与 YAML-HTTP 工具

**PluginLoader**（plugin/loader.py）：`DEFAULT_PLUGIN_ROOT = ~/.flocks/plugins`（:41）；`scan_directory`（:52-87）支持 .py/.yaml/.yml、跳过 `_` 前缀；加载顺序 用户级→项目级→cfg.plugin（:355-425）；YAML 经 `yaml_item_factory`（:547-624），按 dedup_key 首胜去重（:627-674）。

**YAML-HTTP 工具**（tool_loader.py `yaml_to_tool` :576-689）：
```yaml
name: test_tool
description: A test tool
category: custom
handler:
  type: http
  method: GET
  url: https://api.example.com/query
  query_params: {"q": "{query}"}
inputSchema:
  type: object
  properties:
    query: {type: string}
  required: [query]
```
- `{param}` 与 `{secret:xxx}` 模板替换（:176-210）；`response.extract` 点路径抽取（:425-437）；每请求新建 TCPConnector 防 CLOSE_WAIT 泄漏（:312-336）
- 子目录推断 source（api→"api"、device→"device"）；provider 存 storage_key（含版本号，config/api_versioning.py:70-85）
- 合并 `_provider.yaml` 默认值（:119-147）；内联 `execution:` 已禁用（:560-569）

**probe_loader.py**：读每个 API 插件目录 `_test.yaml`（:29），导出连通性探针 `connectivity: {tool, params}` 与样例 `fixtures:`，供测试凭据与 WebUI；自身不注册工具。

### 2.6 设备工具：device_id 绑定与凭据注入

**核心原则：敏感值从不进入 schema，只在请求发出瞬间解析注入。**

- `source=="device"` 且未声明 device_id → schema **合成** `device_id` 参数暴露给 LLM（registry.py:175-188）
- 执行时 pop device_id → `_resolve_device_target`：单台启用设备自动解析；无/多台返回中文错误要求 `device_manage(action='list')` 确认（registry.py:1071-1085）
- `activate_device_credentials`（credential_context.py:129-163）设置 6 个 ContextVar（secret/config/service/storage_key/active_device_id/verify_ssl）；按 `_provider.yaml` `credential_fields` 把 `storage:"secret"` 字段映射为 `{secret:sid}` 占位符（:166-269）
- `SecretManager.get()` 优先读 per-device 覆盖（security/secrets.py:113-136）
- **物理隔离**（device/secrets.py:72-117）：secret 字段明文只进 `.secret.json`（mode 0600），SQL fields 列只存 `{secret:device_<uuid>_<key>}`；`mask_for_display` 掩码回显（sk-***abc）；`resolve_for_runtime` 仅在出站请求时刻解析（:161-177）

### 2.7 子代理/委派工具（delegate_task）

- 普通内置工具注册（delegate_task.py:342-391）；`subagent_type` 经 `is_delegatable`（agent/registry.py:77-82，要求 `delegatable and not hidden`）校验
- 工具内创建子 Session（category="task"）、注入 skill 内容、生成权限规则，`SessionLoop.run` 同步执行等待完成（:502-525, 32-166）
- 同会话同 subagent+description 已完成委托去重复用（:220-258）
- 子代理默认 deny `question` 工具（prometheus 例外，:169-208）
- 结果经 `format_sync_subagent_result` 转 ToolResult（subagent_result.py:29-86），末尾附 `<task_metadata>session_id</task_metadata>`
- 后台执行被禁用；`task` 工具是纯转发别名（task.py:33-107）

### 2.8 工具鉴权与安全边界

- 会话层 execution_mode 白名单：registry.py:887-919 与 runner.py:588-592 双检
- 用户确认：`ToolContext.ask`（registry.py:254-298）→ PermissionRequest → permission_callback（流式路径走 PermissionNext.ask，server/routes/tool.py:481-493；HTTP 直连无 session 直接拒绝，:508-518）
- schema 只对本轮 callable 工具构建（runner.py:2300-2317），描述追加 `[Provider: xx | Version: xx]`（runner.py:90-110）
- 延迟工具目录只给名称 + ≤100 字符描述（runner.py:2196-2200），且排除 device 类工具（runner.py:2191）
- `requires_confirmation=True` 实例：model_config.py:133,253、run_workflow.py:364 等；YAML 工具可声明 `requires_confirmation` 或 `safety_checks`（tool_loader.py:641-647）
- invalid 工具 arguments_preview 只给前 500 字符（invalid.py:101-112）

### 2.9 完整调用时序

```
[会话创建] initialize_session_callable_tools(session_id, agent声明工具 + always_load)
[第1轮]    _list_callable_tool_infos_for_turn → callable_schema 并集 → 构建 schema + 延迟工具目录提示
[LLM 返回 function_call] stream_processor 构造 ToolContext → ToolRegistry.execute
[Registry 门控] execution_mode → device_id 解析/凭据激活 → Tool.execute（别名/未知参数/必填/类型强制）
[handler 执行]  内置 handler 或 YAML-HTTP（{param}/{secret:...} 替换发请求）或 delegate_task（建子会话）
[输出]      truncate_output 自动截断（完整内容落盘 tool-output/ + output_path）
[动态发现]  tool_search → add_session_callable_tools → 下一轮 schema 生效可直调
```

## Part 3 — Skill 系统与配置/密钥暴露机制

### 3.1 Skill 发现、加载与渐进式披露

**发现优先级**（skill.py `_discover` :45-63）：

| 优先级 | 目录 | source |
|---|---|---|
| 低 | `~/.claude/skills/**/SKILL.md`、各层 `.claude/skills/` | claude |
| ↑ | `~/.flocks/skill[s]/**/SKILL.md` | flocks |
| ↑ | `<安装根>/.flocks`（源码自带） | flocks/project |
| ↑ | `<项目>/.flocks`（沿目录树向上） | flocks/project |
| 高 | `~/.flocks/plugins/skill[s]/`（后写覆盖） | user |

**frontmatter**（skill.py:70-135）：`name`（正则 `[a-z0-9]+(-[a-z0-9]+)*`）、`description`（1-1024）、`category`、`ui_hidden`；扩展元数据 `metadata.flocks`（:151-159）含 `requires(bins/any_bins/env)`/`install`/`os`/`homepage`/`emoji`。

**渐进式披露两层**：
1. 系统提示只注入技能名 + 首句描述（agent/registry.py:260-266 用 `Skill.list_enabled()` 构建；prompt_builder.py:213-227）
2. 完整正文由 `skill_load` 工具按需加载（skill_load.py:66-165），描述 500 字符头尾截断插入 `… [truncated; load full SKILL.md via skill_load(name="...")] …` 标记（:35-57）；加载结果用 `auto_truncate_bypassed` 跳过 Registry 自动截断（:139-165）

**禁用控制**：`~/.flocks/config/skill_settings.json`（skill.py:612-749，跨进程文件锁）；禁用技能对 LLM 视为不存在（skill_load.py:100-107）。

**flocks_skills**（tool/skill/flocks_skills.py）：find/install/status/install-deps/remove 五子命令；install 进程内调 `SkillInstaller.install_from_source`（:188-194），其余安全拼接 spawn CLI（:227-236）；外部来源 local/clawhub/skills.sh/SafeSkill/curated GitHub（installer.py:102-162；CLI cli/commands/skill.py:226-410）；clawhub 下载含 Zip Slip 防护（installer.py:706-712）。

### 3.2 Skill 与工具的门控关系

- 系统提示强制："If a user query matches a skill and the relevant tools, call `skill_load` first"（rex/prompt_builder.py:193）
- `skill_load` 内双重强制：`is_disabled` 拒绝 + `ctx.ask(permission="skill")` 权限确认（skill_load.py:100-115）
- `skill_load` 是 `PRUNE_PROTECTED_TOOLS`（上下文压缩不可裁剪，session/context_usage.py:495）
- **未找到**：Skill 声明式工具白名单（`allowed_tools`）字段——Skill 对工具编排完全依赖 SKILL.md 正文指令 + 系统提示约束，无 schema 级白名单

### 3.3 密钥管理

**存储**：`~/.flocks/config/.secret.json`（`FLOCKS_CONFIG_DIR` 可覆盖，config.py:848-851,1464-1482），mode 0600，**明文 JSON 无加密**（security/secrets.py:62-111，文件头注明 "For MVP/development use only"）。

**读取链**（security/secrets.py:113-136）：`SecretManager.get()` 优先读 per-device ContextVar 覆盖（`get_secret_override`，credential_context.py:78-110），其次读文件。

**注入而不暴露**：
- 配置文件只允许 `{secret:key_name}` 占位符，解析点：`flocks/security/__init__.py:72-96`（resolve_secret_refs）、`config/config.py:1070-1103`（replace_secret_refs，配 `{env:VAR}`）、`mcp/utils.py:517-561`（MCP 启动前解析）
- 渠道敏感字段（appSecret/botToken/apiKey/token/password/webhookSecret...，channel_secrets.py:18-34）写入 .secret.json 并把配置替换为 `{secret:channel_<id>_<field>}`（:47-92）
- 回显一律掩码：`SecretManager.mask`（secrets.py:192-212，`sk-***abc`）

**server_api_token**：`server/auth.py:25` 定义 `API_TOKEN_SECRET_ID`；缺失时 `secrets.set(id, token_urlsafe(32))`（cli/main.py:86-96）；工作流工具描述明令禁止读取（workflow_config_manage.py:45,67）。

### 3.4 配置暴露为工具

| 工具 | 读写目标 | 关键机制 |
|---|---|---|
| `flocks_mcp` | flocks.json `mcp` 段 + `~/.flocks/plugins/tools/mcp/{name}.yaml`（tool_loader.py:1131-1178） | URL query 敏感参数自动抽取为 `{secret:...}`（mcp/utils.py:313-429）；schema 提示 `{secret:key_name}` 写法 |
| `add_provider` | flocks.json `provider` 段（config_writer.py:171-184） | `requires_confirmation=True`；api_key 单独落 .secret.json（model_config.py:196-197），返回仅掩码 |
| `add_model` | `provider.<id>.models.<model_id>`（config_writer.py:246-272） | 同步内存 Provider 注册表 |
| `list_providers` | 内存 Provider 注册表 | 只输出 is_configured 状态与模型能力，**不输出密钥** |
| `session_manage` | SQLite Storage，key `session:<project_id>:<id>`（session_manage.py:127-137） | delete 需权限确认（:217-230）；archive 拒绝归档当前会话（:509-513） |
| `workflow_config_manage` | WorkflowStore（integration/poller/syslog/kafka 四类，:30-36） | `status` 不返回全文（:354-388）；put/sync 强制 `_confirm_write`（:391-401）；校验复用 FastAPI Pydantic 模型（:283-330） |
| `device_manage` | SQLite `device_integrations`（fields 为 JSON 列，models.py:40-57） | create/update 入口拒绝敏感字段（见 3.5） |

配置写入均为原子写（tmp + os.replace）+ 清 Config 缓存（config_writer.py:93-137）。

### 3.5 设备模板机制与敏感字段隔离

- **模板身份**：插件 `_provider.yaml`（`integration_type: device`）；`list_device_templates`（plugin_index.py:41-110）合并 Hub 目录 + 本地 descriptor
- **字段模型** `APIServiceCredentialField`（api_service_schema.py:32-45）：`storage("config"|"secret")/sensitive/required/input_type("password"...)/config_key/secret_id`
- **持久化**（device/secrets.py:72-117）：`storage=="secret"` → `secrets.set("device_<id>_<key>", value)`，SQL 只存 `{secret:...}`；非敏感字段明文进 SQL
- **入口拒绝**（manage_tool.py:256-273,360-374）：create/update 检测 `storage=="secret"`/`sensitive==true`/`input_type=="password"`/`key in _SENSITIVE_FIELD_KEYS`（api_key/apikey/secret/client_secret/password/passwd/token/access_token/refresh_token/cookie）即拒绝——**敏感值只能经设备接入页面表单进入**，agent 无法触碰/读取任何明文凭据；创建后返回 `sensitive_fields_to_complete` 提示
- **上下文注入**（device/prompt.py:21-143）：`<DeviceAssetContext>` 只给 device_id/tool_set_id/工具名与首句描述/禁用名单，**不含字段值**

### 3.6 子代理配置与 load_skills 注入

- Agent 定义 = 目录（agent.yaml + prompt.md/prompt_builder.py）；`mode: primary|subagent`、`delegatable`、`model`、`tools` 列表（agent_factory.py:84-200）；扫描顺序 内置→用户插件→项目 bundle（:223+）
- `load_skills` 注入：delegate_task 内部读取**完整 SKILL.md 正文**拼进子代理 system 部分（delegate_task.py:261-286,495-499），子代理无需再调 skill_load；禁用技能视为不存在
- 父代理系统提示强制"每个 skill 必须评估是否进 load_skills，省略必须给理由"（agent/prompt_utils.py:209-248）

### 3.7 配置与密钥分层一览表

| 配置项 | 存储位置 | 暴露给 agent 的方式 | 敏感字段处理 |
|---|---|---|---|
| Skill 技能本体 | `.claude/skills/`、`.flocks/skill[s]/`、`.flocks/plugins/skill[s]/` | 系统提示只给 name+首句摘要；skill_load 按名加载全文 | metadata.flocks 声明 install 依赖 |
| Skill 禁用状态 | `~/.flocks/config/skill_settings.json` | 不暴露 | 禁用技能视为不存在 |
| 平台密钥 | `~/.flocks/config/.secret.json`（0600 明文） | 不直接暴露；`{secret:key_name}` 在执行/出站时注入 | SecretManager.mask 掩码回显 |
| 渠道敏感字段 | .secret.json；flocks.json 只留占位符 | 不暴露 | SENSITIVE_FIELD_NAMES 清单（channel_secrets.py:18-34） |
| Provider/模型 | flocks.json(c) `provider` 段 | list_providers 只给状态/能力 | api_key 单独落 .secret.json |
| MCP 配置 | flocks.json `mcp` 段 + `~/.flocks/plugins/tools/mcp/{name}.yaml` | flocks_mcp 五子命令 | URL/header 敏感参数自动抽为 {secret:...} |
| 会话元数据 | SQLite Storage `session:` 前缀 | session_manage 六动作 | delete 权限确认 |
| 工作流配置 | WorkflowStore / config.json 兜底 | workflow_config_manage | status 不返回全文；写操作确认 |
| 设备非敏感配置 | SQLite device_integrations.fields | device_manage + DeviceAssetContext | 无 |
| 设备敏感凭据 | .secret.json（device_<id>_<field>） | 不暴露；出站请求时 resolve_for_runtime | mask_for_display 掩码 |
| server_api_token | .secret.json | 不暴露（工具明令禁止读取） | token_urlsafe(32) 生成 |

**未找到/说明**：Skill 无声明式工具白名单字段；.secret.json 无加密层（MVP 明文）。

## 附录 — 开发教程速查

**A. 新建 SOC 工作区页面**：① 定 pageId（小写+数字+连字符）与标题，选所属 section；② 在 `~/.flocks/plugins/contracts/webui/soc_ui/<page_dir>/` 建 `manifest.json` + `src/index.tsx` + `src/Page.tsx`（可含 api/）；③ 把 pageId 加入 workspace.json 对应 section 的 pageIds（必要时更新 defaultPageId）；④ 等 watcher 自动构建，失败查 `dist/meta.json` error；⑤ 访问 `/contracts/webui/workspaces/soc_ui/<pageId>`。

**B. API 与数据契约选择**：页面专属统计/查询 → `api/routes.yaml`+`handlers.py` → `api.page.get('/xxx')`；复用告警数据 → `api.contract('soc/alerts','soc.alerts.operations').operation('list', {...})`；内置 Flocks 数据 → `api.get('/api/...')`；多步编排 → Workflow `POST /api/workflow/{id}/run`；第三方 API → 必须经页面后端代理（防 CORS 与密钥泄露）。

**C. 白名单与禁令**：只允许 import `react`、`@flocks/webui-contract-sdk`；禁止手改 dist/、import 非白名单包、src 中写 Token/密钥、注册全局 /api/custom 路由、把页面源码留在仓库代码目录。页面路由：`/contracts/webui/<pageId>`（页面级）、`/contracts/webui/workspaces/<workspaceId>/<pageId>`（工作区级）。

**D. 调试入口**：导航缺失 → manifest.enabled/buildStatus/watcher；空白/报错 → `GET /api/contracts/webui/pages/<id>` 的 build.error、`dist/meta.json`；构建失败 → TSX 语法、白名单 import；页面 API 404 → routes.yaml 路径与 pageId、`POST .../api/reload`；API 500 → `dist/api-meta.json`、handler traceback；401 → 登录态失效（WebUI）/缺 Bearer Token（脚本）。
