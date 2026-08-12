# 工具暴露阶段声明（deferLoading）与用户覆盖 — 实施计划

日期：2026-08-05
状态：已完成（2026-08-07）

> 2026-08-12 更新（Issue #4）：插件工具 `_meta.deferLoading` 缺失或无效时的默认值
> 从 `false`（常驻）改为 `true`（按需），避免未知插件工具因缺少元数据而永久 resident。
> 显式 `false` 仍表示常驻。详见 `docs/done-4-plugin-generic-routing.md`。

## 1. 背景与目标

当前分层工具路由（`src/apps/server/src/runtime/toolRouter.ts` + `agentRuntime.ts`）的
triage/deep 两阶段暴露由**路由侧硬编码分类**决定：

- `SKILLPACK_CATEGORY` / `CATEGORY_PATTERNS` 硬编码了 `wazuh.` / `shuffle.` 等命名前缀
- 未知前缀的第三方插件工具全部落入 `core-triage`（triage 阶段全量暴露，token 优化失效）
- 用户无法控制"某工具在 triage 阶段是否可见"

目标：**工具/插件自声明暴露阶段**（对齐 Anthropic/OpenAI 2026 年官方 `defer_loading` 机制），
用户可在运行时覆盖单个工具的暴露级别。同时解决"分类规则硬编码"耦合。

## 2. 已定稿设计决策

| 决策 | 定稿 |
|---|---|
| 声明字段 | `SkillManifest.deferLoading: boolean`（必填；`false`=常驻，triage+deep 均暴露；`true`=按需，仅 deep 暴露）。对齐业界 2026 命名 |
| deep 阶段策略 | **保留类别推断**：deep = 常驻工具（非 defer）+ 按类别推断加载的 defer 工具。37 工具处于官方 30–50 精度拐点内，deep 不全量加载 |
| 用户覆盖入口 | 后端 API + `runtime/config/toolVisibility.json` 持久化；插件 `_meta` 声明默认值；**本轮不做前端 UI** |

## 2.5 已完成的相关修改（提交 c5b7fe6，执行前请先确认存在）

以下三处修改已在主分支落地并全量测试通过（server 72/72 全绿），本计划在其之上实施，
**执行窗口 AI 请先确认这些修改已存在**，避免重复改动或遗漏关联：

1. **toolRouter.build() 每次重建分类**（`src/apps/server/src/runtime/toolRouter.ts` 的 `build()`）
   - 已移除 `if (this.initialized) return;` 短路——插件 reload 注册新工具后分类映射必须重建
     （此前 bug：插件工具在 `/api/plugins` 显示已加载，但 agent run 的工具集里不可达）
   - `initialized` 字段保留（仅不再短路）
   - 本计划 4.5 的 `alwaysVisibleIds`/`deferredIds` 收集直接加在 `build()` 的分类循环中
   - 回归测试：`src/apps/server/test/toolRouter.test.ts`（"reclassifies after plugin tools are registered on a later run"）

2. **deep 阶段固定加载 sandbox-actions**（`src/apps/server/src/runtime/agentRuntime.ts` 约 244-248 行）
   - `deepCategories.add("sandbox-actions")`：动作工具（case.note.write / command.run.sandbox / full_access.exec）
     不依赖关键词推断即可达（修复"拉黑/记笔记"等说法不在关键词表导致动作工具不可达）
   - 本计划 4.6 改造后**此逻辑保留**：sandbox-actions 工具默认 `deferLoading: true`，
     deep 阶段仍通过类别固定加入，行为不变

3. **inferCategories 关键词扩充**（`src/apps/server/src/runtime/toolRouter.ts` 的 `inferCategories()`）
   - wazuh-platform 增加：拉黑 / 拦截 / 检测 / 排查 / 监控 / 防护 / 入侵 / 漏洞 / 威胁
   - reporting 增加：总结 / 分析报告（原 "case" 英文词已移至 sandbox-actions）
   - sandbox-actions 增加：笔记 / 案例 / 沙箱 / note
   - 本计划**不改 inferCategories**（4.5 只新增暴露集合收集，类别推断逻辑保持现状）

## 3. 术语

- **常驻工具（non-deferred）**：`deferLoading: false`。triage 阶段与 deep 阶段均可见
- **按需工具（deferred）**：`deferLoading: true`。仅 deep 阶段可见（且需类别推断命中）
- **用户覆盖**：以工具 manifest id 为键的 `deferLoading` 覆盖表，优先级高于插件/内置声明

## 4. 改动清单（按文件，精确到函数）

### 4.1 共享类型 — `src/packages/shared/src/index.ts`

`SkillManifest` 接口（约第 53 行）新增必填字段：

```ts
export interface SkillManifest {
  // ...现有字段
  /** 工具暴露级别：false=常驻（triage 与 deep 阶段均暴露）；true=按需（仅 deep 阶段暴露）。 */
  deferLoading: boolean;
}
```

### 4.2 内置工具声明 — `src/apps/server/src/tools/`

三个集中 manifest helper 各加一行（**全部内置工具由此覆盖**）：

| 文件 | helper | 位置 | 值 |
|---|---|---|---|
| `secopsTools.ts` | `function manifest(input)` | 约 424 行 | `deferLoading: false`（core 工具常驻，保持现状） |
| `actionTools.ts` | `function manifest(input)` | 约 154 行 | `deferLoading: true`（sandbox-actions 按需） |
| `reportTools.ts` | `function reportManifest(input)` | 约 259 行 | `deferLoading: true`（reporting 按需） |

注意：`secopsTools.ts` 的 helper 覆盖全部 core 工具（7 个），`deferLoading: false` 保持
triage 行为不变。若有非 core 工具走此 helper，需单独评估。

### 4.3 插件声明 — `src/plugins/*/src/tools/`

插件包有独立的 `SkillManifest` 类型副本（**不是** shared 的那个）：

1. `plugins/wazuh-secops/src/tools/types.ts` 与 `plugins/shuffle-secops/src/tools/types.ts`：
   `SkillManifest` 接口加 `deferLoading: boolean`（同上字段）
2. 各插件包的集中 manifest helper 加 `deferLoading: true`（插件工具默认按需/仅 deep，保持现状）：
   - `wazuh-secops/src/tools/registry.ts` 约 692 行 `function manifest(input)`
   - `wazuh-secops/src/tools/securityOperationsTools.ts`（约 118 行附近，若为独立 manifest 构造点）
   - `shuffle-secops/src/tools/registry.ts` 的对应 helper
3. 插件 MCP server 的 `_meta` 透传（两个文件同构，各改一处）：
   - `plugins/wazuh-secops/src/adapters/mcpServer.ts` 与 `plugins/shuffle-secops/src/adapters/mcpServer.ts`
   - `registerTool` 的 `_meta` 对象加：`deferLoading: tool.manifest.deferLoading`

### 4.4 主服务插件解析 — `src/apps/server/src/plugins/pluginManager.ts`

`mcpToolToSecOpsTool()`（约 285 行）：manifest 构造加

```ts
deferLoading: meta.deferLoading === true,   // 缺失/非布尔 → false（常驻，安全默认）
```

### 4.5 分层路由改造 — `src/apps/server/src/runtime/toolRouter.ts`

1. `build(registry)`：分类循环中同时收集两个集合（新增私有字段）：
   ```ts
   private alwaysVisibleIds: string[] = [];   // deferLoading=false 的全部工具 id
   private deferredIds: string[] = [];        // deferLoading=true 的全部工具 id
   ```
   分类逻辑（skillPackId/前缀）**保留不动**（deep 类别推断继续使用）
2. `getTriageToolIds()`：返回值从 `core-triage` 改为 **`alwaysVisibleIds`**
   （core 工具均为 deferLoading=false，行为与现状等价；用户设为常驻的非 core 工具现在也会进 triage）
3. deep 工具集（`agentRuntime.ts` 调用处，见 4.6）：`getSpecializedToolIds(推断类别)` 结果
   **并入 `alwaysVisibleIds`**（常驻工具在 deep 同样可见）
4. 删除/保留 `core-triage` 类别：类别映射保留（`inferCategories` 始终返回 `core-triage`，
   且 deep 的兜底依赖类别），但 triage 不再直接读它

### 4.6 执行层 — `src/apps/server/src/runtime/agentRuntime.ts`

`run()` 中 deep 阶段（约 246 行附近，现有代码）：

```ts
const deepCategories = new Set(inferredCategories);
deepCategories.add("sandbox-actions");
const deepToolIds = toolRouter.getSpecializedToolIds([...deepCategories]);
```

改为（常驻工具并入 deep）：

```ts
const deepCategories = new Set(inferredCategories);
deepCategories.add("sandbox-actions");
const deepToolIds = toolRouter.getDeepToolIds([...deepCategories]);  // 见下
```

推荐：在 `toolRouter` 增加 `getDeepToolIds(categories)`，内部
`return union(this.alwaysVisibleIds, this.getSpecializedToolIds(categories))`；
或直接在 agentRuntime 里 `[...new Set([...toolRouter.getTriageToolIds(), ...toolRouter.getSpecializedToolIds(deepCategories)])]`。
二选一，推荐前者（逻辑内聚在 toolRouter）。

### 4.7 用户覆盖存储 — 新文件 `src/apps/server/src/runtime/toolVisibilityStore.ts`

仿 `ModelConfigStore` / `RuntimeSettingsStore` 模式：

```ts
export class ToolVisibilityStore {
  constructor(private readonly filePath: string) {}   // 构造时 load()
  get(): Record<string, boolean>;                      // 用户覆盖表 { toolId: deferLoading }
  set(toolId: string, deferLoading: boolean): void;    // 设覆盖 + persist()
  clear(toolId: string): boolean;                      // 清除覆盖 + persist()；返回是否曾存在
}
```

- 文件不存在 → 空表
- 持久化格式：`{ "toolId": true, "toolId2": false }`（JSON 缩进 2）
- 损坏文件 → 抛错（与 RuntimeSettingsStore 一致）

### 4.8 配置 — `src/apps/server/src/config.ts`

`AppConfig` 新增字段 + `getConfig()` 解析（仿 `modelConfigPath`）：

```ts
toolVisibilityPath: resolveWorkspacePath(env.SECOPS_TOOL_VISIBILITY_PATH, workspaceRoot, path.join("runtime", "config", "toolVisibility.json"))
```

`.env.example` 增加 `SECOPS_TOOL_VISIBILITY_PATH=runtime/config/toolVisibility.json` 注释行。

### 4.9 注册表覆盖 — `src/apps/server/src/tools/registry.ts`

`ToolRegistry` 增加用户覆盖层（`manifests()` 输出应用覆盖后的值，`/api/tools` 展示即覆盖后状态）：

```ts
private deferLoadingOverrides = new Map<string, boolean>();

setDeferLoadingOverride(id: string, deferLoading: boolean): boolean;  // 不存在返回 false
clearDeferLoadingOverride(id: string): boolean;                        // 不存在返回 false
```

`manifests()` 返回时：`{ ...manifest, deferLoading: overrides.get(id) ?? manifest.deferLoading }`
（复制对象，不修改内部存储）。

### 4.10 API — `src/apps/server/src/app.ts`

新增三个路由（放在 `/api/tools` 附近；`ToolRegistry` 与 `ToolVisibilityStore` 在 `buildServer`
内创建，启动时把 store 的覆盖灌入 registry）：

```ts
// 启动（buildServer 内）：
const toolVisibilityStore = new ToolVisibilityStore(config.toolVisibilityPath);
for (const [id, deferLoading] of Object.entries(toolVisibilityStore.get())) {
  registry.setDeferLoadingOverride(id, deferLoading);
}

// 路由：
GET    /api/tools/visibility                → { visibility: Record<string, boolean> }（用户覆盖表）
PUT    /api/tools/visibility/:id            body { deferLoading: boolean } → 校验 id 存在 → set + 持久化 → 返回更新后的覆盖表；404 若工具不存在；400 若 deferLoading 非布尔
DELETE /api/tools/visibility/:id            → clear + 持久化 → 返回覆盖表；404 若工具不存在或未覆盖
```

注意：`id` 必须是 `registry.manifests()` 中存在的 manifest id（校验）。

### 4.11 测试

| 文件 | 内容 |
|---|---|
| `src/apps/server/test/toolRouter.test.ts`（扩展） | ① 声明 deferLoading=false 的非 core 工具进入 `getTriageToolIds()`；② deferLoading=true 的工具不进 triage、经类别推断进 deep；③ deep 工具集包含常驻工具 + 推断 defer 工具 |
| `src/apps/server/test/toolVisibilityStore.test.ts`（新增） | 空表/设覆盖/清除/持久化重载/坏文件抛错 |
| `src/apps/server/test/registry.test.ts`（扩展） | `setDeferLoadingOverride` 后 `manifests()` 反映覆盖值；clear 后回退声明值；不存在的 id 返回 false |
| `src/apps/server/test/toolCatalogApi.test.ts`（扩展） | 假插件工具 `_meta.deferLoading: true` → `/api/tools` 中 `deferLoading: true`；PUT `/api/tools/visibility/:id` 后 triage 包含该工具（经 `/api/agent/run` 或用 `getTriageToolIds` 断言）；DELETE 回退 |
| 既有测试适配 | 所有 `SkillManifest` 构造点（测试内 `testManifest`/`base` 对象、`agentRuntime.test.ts`、`mcp.test.ts`、`registry.test.ts`、`toolCatalogApi.test.ts` 等）补 `deferLoading` 字段（值按工具语义：测试工具默认 `false` 或按需） |

### 4.12 文档

- `README.md`：分层路由章节补充"工具暴露级别"说明（deferLoading 语义 + 用户覆盖 API）
- `.env.example`：见 4.8

## 5. 实施顺序

1. 4.1 shared 类型 → 4.2 内置工具声明 → 4.3 插件声明 → 4.11 测试适配（先让编译通过：
   `cd src && npm run typecheck`）
2. 4.4 PluginManager 解析 → 4.5/4.6 toolRouter 改造 → 扩展 toolRouter 测试
3. 4.7 Store → 4.8 config → 4.9 registry 覆盖 → 4.10 API → 新增/扩展测试
4. 4.12 文档 → 全量验证

## 6. 验证命令

```powershell
cd src
npm run typecheck                                    # 全包类型检查（shared/插件/server/web）
npm test -w @secops-agent/server                     # server 测试全绿（含新增）
npm test -w @secops-agent/wazuh-secops               # 插件包回归
npm test -w @secops-agent/shuffle-secops
npm test -w @secops-agent/web                        # 前端零回归
npm run build:runnable                               # 发布包构建（验证插件复制与编译链）
```

## 7. 完成标准

- `SkillManifest.deferLoading` 全链路生效：内置（core=false，其余=true）、插件（默认 true，`_meta` 透传）
- triage 工具集 = 所有常驻工具；deep 工具集 = 常驻 + 类别推断 defer 工具
- 用户可通过 API 覆盖任意工具的暴露级别并持久化；`/api/tools` 展示覆盖后状态
- 未知前缀第三方插件工具可被用户手动设为常驻（triage 可见），解决"分类硬编码"耦合
- 全量测试绿；无前端改动

## 8. 明确不做（本轮）

- 前端 UI（勾选暴露级别）——API 已铺路，后续接
- 语义检索式工具选择（Anthropic tool search / embedding）——插件数量增长后再评估
- MCP 协议层改动（2026-07-28 规范无协议内延迟加载，按需加载属 API 层概念）
- `decidePolicy` 执行权限体系不动（暴露级别只影响上下文可见性，不影响执行审批）

## 9. 注意事项

- `deferLoading` 是**上下文可见性**声明，与执行权限（`decidePolicy`）正交——不要混用
- MCP 2026 规范明确 `annotations`/`_meta` 不可信：插件 `_meta` 缺失 `deferLoading` 时默认
  `false`（常驻）属于**安全默认**（triage 暴露不授予执行权），如需保守可改为默认 `true`，
  由插件显式声明常驻
- 改动涉及 shared 类型（必填字段），所有构造点必须同步补字段，否则 typecheck 失败——
  按 4.11 测试适配清单逐处补齐
