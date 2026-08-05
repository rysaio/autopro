# 工具权限模型修正：移除工具自声明权限，放行由全局权限模式决定 — 实施计划

日期：2026-08-05
状态：待执行（供执行窗口 AI 直接照做，无需本会话上下文）

## 1. 背景与问题

当前 `SkillManifest.defaultPermission` 让**工具/插件自声明权限模式**（ask/auto），
`decidePolicy`（`src/apps/server/src/tools/registry.ts`）信任该声明：

```ts
if (!approvedReplay && (context.permissionMode === "ask" || tool.manifest.defaultPermission === "ask")) {
  return { status: "pending_approval", ... };
}
```

问题：
- 插件可在 `_meta.permission` 里声明自己的权限，主服务信任——恶意/被篡改插件可声明
  auto 绕过审批（`/api/mcp/tools/:name/call` 端点客户端还可自报 `permissionMode: "auto"`）
- 权限语义分散：工具声明 + 请求级 permissionMode + 部署级 actionLevel 三层混用

**原则（用户定稿）**：工具只能被运行，**放行策略由用户决定**，且是**全局三态模式**
（作用于所有工具），不是 per-tool 配置：

| 全局模式 | 语义 |
|---|---|
| `ask` | 非 action（读取类）自由调用；**所有 action 工具均需审批** |
| `auto` | 自动运行所有工具；**可选开关**：risk=high 的工具仍入审批 |
| `deny` | 只读：仅非 action 可调用，action 一律拒绝 |

## 2. 设计决策（已定稿）

1. **彻底移除 `SkillManifest.defaultPermission`**（shared 类型、内置工具、插件类型副本、
   插件 `_meta.permission`、PluginManager 解析、MCP 暴露）
2. **`decidePolicy` 重构**：不再读 `defaultPermission`，按全局权限模式（请求级
   `permissionMode` + 部署级 `actionLevel`）判定，语义见上表
3. **auto 模式高危开关**：运行时设置 `autoApproveHighRisk: boolean`（扩展 RuntimeSettings，
   **默认 `true`（更保守）**：auto 模式下 risk=high 的 action 默认仍入审批；用户可关闭
   实现全自动
4. **不引入 per-tool 权限配置**（用户明确否定）；`actionLevel`（observe/sandbox/full-access）
   部署级闸门保留

## 3. 术语

- **action 工具**：`manifest.toolClass === "action"`（工具属性声明，保留）
- **risk**：`manifest.risk`（工具属性声明，保留；high 用于 auto 模式例外审批）
- **全局权限模式**：请求级 `permissionMode`（agent run / MCP 调用端点传入，三态）+
   部署级 `actionLevel`（runtimeSettings 持久化）

## 4. 改动清单（按文件，精确到位置）

### 4.1 共享类型 — `src/packages/shared/src/index.ts`

1. `SkillManifest` 接口删除 `defaultPermission: PermissionMode` 字段
2. `RuntimeSettings` 接口扩展（可选字段，向后兼容）：

```ts
export interface RuntimeSettings {
  actionLevel: AutomationLevel;
  /** auto 模式下 risk=high 的 action 工具是否仍需审批（默认 true，保守）。 */
  autoApproveHighRisk?: boolean;
}
```

### 4.2 内置工具 — `src/apps/server/src/tools/`

三个集中 manifest helper 删除 `defaultPermission` 行：

| 文件 | 位置 | 删除内容 |
|---|---|---|
| `secopsTools.ts` | 约 436 行 | `defaultPermission: "auto",` |
| `actionTools.ts` | 约 166 行 | `defaultPermission: input.risk === "high" ? "ask" : "auto",` |
| `reportTools.ts` | 约 271 行 | `defaultPermission: "auto",` |

### 4.3 插件包 — `src/plugins/*/src/`

1. 类型副本删字段：`wazuh-secops/src/tools/types.ts` 与 `shuffle-secops/src/tools/types.ts`
   的 `SkillManifest` 删 `defaultPermission: PermissionMode;`（约 21 行）
2. 插件集中 helper 删行：
   - `wazuh-secops/src/tools/registry.ts` 约 704 行
   - `wazuh-secops/src/tools/securityOperationsTools.ts` 约 119 行
   - `shuffle-secops/src/tools/registry.ts` 约 570 行
   均为 `defaultPermission: input.toolClass === "action" ? "ask" : "auto",`
3. 插件 MCP server `_meta` 删除 permission 透传：
   - `wazuh-secops/src/adapters/mcpServer.ts` 约 37 行
   - `shuffle-secops/src/adapters/mcpServer.ts` 约 37 行
   `_meta` 保留 `manifestId`/`risk`/`toolClass`，删除 `permission`

### 4.4 主服务插件解析 — `src/apps/server/src/plugins/pluginManager.ts`

`mcpToolToSecOpsTool()`（约 285-310 行）：
- manifest 构造删除 `defaultPermission: toPermission(meta.permission),`
- 删除 `toPermission()` 辅助函数（不再使用）

### 4.5 MCP 暴露 — `src/apps/server/src/mcp/secopsMcpServer.ts`

约 29 行：删除 `permission: manifest.defaultPermission`（MCP 工具元数据不再暴露权限声明）。

### 4.6 权限判定重构 — `src/apps/server/src/tools/registry.ts`

`decidePolicy()`（约 223-250 行）重构为：

```ts
function decidePolicy(
  tool: SecOpsTool,
  context: ToolContext,
  callId: string,
  autoApproveHighRisk: boolean
): { status: "executed" } | { status: "denied" | "pending_approval"; reason: string } {
  // 非 action（读取类）在所有模式下自由调用
  if (tool.manifest.toolClass !== "action") {
    return { status: "executed" };
  }
  // 部署级 actionLevel 闸门
  if (context.actionLevel === "full-access") {
    return { status: "executed" };
  }
  if (context.actionLevel === "observe") {
    return { status: "denied", reason: "Action tools are disabled at SECOPS_ACTION_LEVEL=observe" };
  }
  if (tool.manifest.id === "full_access.exec") {
    return { status: "denied", reason: "Full access exec requires SECOPS_ACTION_LEVEL=full-access" };
  }
  // 审批通过后的重放
  if (context.approvedToolCallIds?.includes(callId) ?? false) {
    return { status: "executed" };
  }
  // 全局权限模式（请求级 permissionMode）
  if (context.permissionMode === "deny") {
    return { status: "denied", reason: "Action tool execution denied by permission policy" };
  }
  if (context.permissionMode === "ask") {
    // ask：所有 action 工具均需审批（不再区分工具声明）
    return { status: "pending_approval", reason: "Action tool requires explicit analyst approval" };
  }
  // permissionMode === "auto"：自动执行，可选高危例外
  if (autoApproveHighRisk && tool.manifest.risk === "high") {
    return { status: "pending_approval", reason: "High risk action tool requires approval under auto mode policy" };
  }
  return { status: "executed" };
}
```

调用处 `executeApiTool()`（约 129 行）传入开关：

```ts
const policy = decidePolicy(tool, context, callId, this.autoApproveHighRisk);
```

`ToolRegistry` 增加构造参数或 setter：

```ts
constructor(
  tools?: SecOpsTool[],
  approvals?: PendingApprovalStore,
  private autoApproveHighRisk = true   // 默认 true（保守）：auto 模式下高危仍审批
) {}
```

注意：**原 `permissionMode === "deny"` 分支在最前**（deny 且非 full-access 时 action 拒绝）；
新逻辑把 deny 移到 action 闸门之后（语义等价：非 action 在 deny 下仍可调用——与用户
"deny 只允许非 action 操作"一致）。请核对 approval 相关测试。

### 4.7 运行时设置 — `src/apps/server/src/runtime/runtimeSettings.ts`

`RuntimeSettingsStore` 支持 `autoApproveHighRisk`：
- 构造默认 `{ actionLevel, autoApproveHighRisk: true }`
- `load()` 解析（缺失 → true，保守默认）
- 新增 `setAutoApproveHighRisk(value: boolean): RuntimeSettings`
- `persist()` 输出两字段

### 4.8 app.ts — `src/apps/server/src/app.ts`

1. `buildServer` 内：`registry` 创建后应用运行时开关——
   `registry.autoApproveHighRisk = runtimeSettings.get().autoApproveHighRisk ?? false`
   （或经 ToolRegistry setter；`/api/settings/action-level` 之后新增联动：actionLevel 变更
   不影响该开关）
2. 新增 API：

```ts
GET  /api/settings/auto-approve-high-risk → { autoApproveHighRisk: boolean }
PUT  /api/settings/auto-approve-high-risk  body { autoApproveHighRisk: boolean }
     → 校验布尔（400）→ runtimeSettings.setAutoApproveHighRisk + 同步 registry → 返回设置
```

3. `/api/tools` 返回的 manifest 不再含 `defaultPermission`（自动生效）

### 4.9 测试

| 文件 | 内容 |
|---|---|
| `registry.test.ts` | 删除 25-26 行 defaultPermission 断言；`testManifest` 删字段（约 252 行）；**新增**：① ask 模式下所有 action（含原 auto 类如 case.note.write）pending_approval；② auto 模式（默认 autoApproveHighRisk=true）下 risk=high 的 action pending_approval、risk=medium/low 执行；③ autoApproveHighRisk=false 时 case.note.write/block_ip 均 executed；④ deny 模式非 action 执行、action 拒绝 |
| `toolCatalogApi.test.ts` | 假插件 `_meta` 删 permission 字段（约 141 行）；全链路审批测试注释更新（约 193 行）——语义不变（sandbox+ask → 所有 action 审批） |
| `agentRuntime.test.ts` | `testManifest` 删字段（约 304 行） |
| `mcp.test.ts` | `base` manifest 删字段（约 19 行） |
| `toolRouter.test.ts` | `pluginTool` 删字段（约 17 行） |
| `settings.test.ts` | 扩展：autoApproveHighRisk 持久化/默认 false/API |
| 插件包测试 | wazuh/shuffle 包内 `testManifest`/fixtures 若有 defaultPermission 一并删除 |
| 行为变化审查 | **auto 请求 + risk=high action 从"审批"变为"执行"**（原 defaultPermission=ask 仅 block_ip 类）：grep 现有测试中 `permissionMode: "auto"` + 高危工具的断言，确认/适配（如 approval.test.ts） |

### 4.10 文档

- `README.md` 权限模型章节重写：三态语义表（ask/auto/deny）+ 高危开关 API +
  defaultPermission 移除说明 + "工具只声明属性，放行由全局模式决定"
- `.env.example` 无需新变量（autoApproveHighRisk 是运行时设置，非 env）

## 5. 实施顺序

1. 4.1 shared 类型 → 4.2/4.3 内置与插件删字段 → 4.9 测试适配（先 `cd src && npm run typecheck` 全绿）
2. 4.4 PluginManager → 4.5 MCP 暴露 → 4.6 decidePolicy 重构 → 4.7 runtimeSettings → 4.8 API
3. 4.9 新增权限语义测试（ask 全审批/auto 高危开关/deny 只读）→ 行为变化审查
4. 4.10 文档 → 全量验证

## 6. 验证命令

```powershell
cd src
npm run typecheck
npm test -w @secops-agent/server
npm test -w @secops-agent/wazuh-secops && npm test -w @secops-agent/shuffle-secops
npm test -w @secops-agent/web
npm run build:runnable
```

## 7. 完成标准

- `defaultPermission` 全代码库消失（grep 无结果）
- decidePolicy 三态语义正确：ask=所有 action 审批；auto=全执行但**默认 risk=high 仍审批**
  （autoApproveHighRisk=true，用户可关闭）；deny=只读；非 action 任何模式可调用
- 插件 `_meta` 不再传递/信任 permission；`/api/mcp/tools/:name/call` 客户端自报
  permissionMode 的滥用面收窄（auto 下不再有"工具声明 ask"可被绕过，且高危默认全自动
  由用户开关控制）
- autoApproveHighRisk 运行时设置可持久化、可 API 修改、同步生效
- 全量测试绿

## 8. 明确不做（本轮）

- per-tool 权限配置（用户否定）
- 前端 UI（权限模式选择沿用现有全局切换；高危开关 UI 后续接）
- `actionLevel` 语义变更（observe/sandbox/full-access 保留为部署级闸门）
- deferLoading 计划（`docs/plans/2026-08-05-tool-exposure-routing.md`）独立执行；
  注意两者都会改插件 `_meta`——**若并行执行需合并冲突**（deferLoading 加字段、
  本计划删字段，互不重叠）

## 9. 注意事项

- **行为变化**：auto 请求下 risk=high 的 action（如 wazuh.block_ip，原 defaultPermission=ask）
  默认仍审批（autoApproveHighRisk=true，保守）；用户关闭开关后全自动执行
- `PermissionMode` 类型保留（permissionMode 请求级三态仍需）
- `ToolContext.permissionMode` 语义不变；`full-access` 部署级仍无视请求级模式
- MCP 2026 规范视角：`_meta` 不可信——本计划正是消除对 `_meta.permission` 的信任
