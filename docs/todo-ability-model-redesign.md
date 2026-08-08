# 能力模型重构设计方案（skill / plugin / mcp）

日期：2026-08-05　状态：草案待确认　作者：前端分支

## 1. 目标概念模型（Claude Code 式）

三类能力来源，统一在界面中呈现：

```
能力（Capability）
├── 独立 Skill（技能）      —— 不属于任何插件，单个技能实体
├── Plugin（插件）           —— 容器，声明式包含：
│     ├── skills[]          —— 插件自带技能（SKILL.md，superpower 模式）
│     └── mcpServers[]      —— 插件自带 MCP 服务器（→ 工具）
└── 独立 MCP 工具（MCP）     —— 不属于任何插件，单独列出
```

现状差距：
- 插件 manifest 已声明 `skills`（如 wazuh-secops 有 5 个 SKILL.md）+ `mcpServers`，
  但 `pluginManager` 只消费 mcpServers，`skills` 目录被忽略
- `PluginSummary` 只有 `toolCount`，无技能/工具明细
- 前端无插件维度展示；"MCP 工具"面板实际显示的是全部工具（非插件维度）

## 2. 数据模型（shared 类型变更）

```ts
export interface PluginSkillSummary {
  id: string;              // skill 目录名，如 wazuh-alert-triage-threat-hunting
  name: string;            // SKILL.md frontmatter 的 name（缺省用目录名）
  description: string;     // SKILL.md frontmatter 的 description（可选）
}

export interface PluginMcpSummary {
  serverName: string;      // .mcp.json 中 server 的 key
  toolIds: string[];       // 该 server 经 listTools 注册的工具 id
}

export interface PluginSummary {
  id: string;
  name: string;
  version: string;
  status: "loaded" | "error";
  error?: string;
  toolCount: number;               // 向后兼容
  skills: PluginSkillSummary[];    // 新增：插件包含的技能
  mcpServers: PluginMcpSummary[];  // 新增：插件包含的 MCP 服务器及工具
}
```

## 3. 后端改动（src/apps/server）

1. `pluginManager.loadPlugin()`：读取 manifest 后
   - 解析 `manifest.skills`（相对路径，如 `./skills/`）→ 递归扫描 `*/SKILL.md`
   - 解析每个 SKILL.md 的 YAML frontmatter（name/description），生成 `PluginSkillSummary[]`
   - 保留现有 mcpServers 流程，在 `registerTools` 时按 server 记录 `toolIds`
2. `status()` 返回增强字段
3. API 不变：`GET /api/plugins` 自动带新字段

## 4. 前端改动（src/apps/web）

技能面板重构为「能力」总览，三区：

1. **插件**：卡片列表
   - 卡片头：插件名 + 版本 + 状态徽章（loaded/error）
   - 描述
   - 「技能」chips：`wazuh-alert-triage-threat-hunting` 等（可展开/悬停看描述）
   - 「MCP 工具」chips：serverName + 工具数
2. **独立技能**：不属于任何插件的 skill 列表
3. **独立 MCP 工具**：不属于任何插件的 MCP 工具列表

数据：`fetchPlugins()`（新增 api.ts 客户端）+ 现有 `fetchSkills`/`fetchMcpTools`。

## 5. 与现有概念的关系

- `SkillPack`（secops-core 等）保留：它是**工具分组**（用于图谱/启用开关），与 Plugin 不同层
- 概念映射：SkillPack ≠ Plugin；Plugin 是外部能力来源（skill + mcp 的容器）

## 6. 实施步骤

1. shared：`PluginSummary` 扩展 + `PluginSkillSummary`/`PluginMcpSummary`
2. 后端：pluginManager 解析 skills 目录 + status 增强（worktree 提交，后端合并时同步）
3. 前端：api.ts 加 fetchPlugins；技能面板改三区
4. 测试：插件加载单测（skills 解析）+ 前端 typecheck
5. （阶段二）独立 skill / 独立 MCP 实例：runtime/skills/ 目录 + 全局 mcp 配置

## 7. 风险与注意

- SKILL.md frontmatter 解析需要轻量 YAML 解析（仅 name/description 两个字段，正则即可）
- 插件 skills 解析失败不应导致整个插件 error（skills 缺失降级为空数组）
- toolCount 字段保留避免破坏现有调用方
