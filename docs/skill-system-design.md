# 技能系统设计文档（模仿 Claude Code / Codex）

日期：2026-08-05　状态：方案已对齐，待实施　作者：前端分支

## 0. 结论

- 采用业界 Agent Skills 标准：skill = 一个目录 + 必填 `SKILL.md`（YAML frontmatter + Markdown 指令）+ 可选附件
- **独立技能包**（`runtime/skills/`）与**插件内技能**（`runtime/plugins/<p>/skills/`）的 skill 结构完全一致，仅来源不同
- 插件 = 技能的批量分发容器（+ MCP）；插件内技能以 `plugin:skill` 命名空间注册
- 加载：启动只注入技能**清单**（name+description）到 agent，**正文激活时才读取**（progressive disclosure）
- 第一版同时把技能清单注入 agent system prompt

## 1. 目录结构（运行时）

```
runtime/
├── skills/                      # 独立技能包（新增；用户放入 skill 文件夹即生效）
│   └── <skill-name>/
│       ├── SKILL.md             # 必填（frontmatter: name / description）
│       └── …附件（scripts/ references/ assets/，第一版仅识别目录，不消费）
└── plugins/<plugin-name>/       # 插件（现有，结构不变）
    ├── .codex-plugin/plugin.json
    ├── .mcp.json
    └── skills/<skill-name>/SKILL.md   # 开始消费（当前加载器无视）
```

## 2. 数据模型（shared 新增）

```ts
export interface SkillFileInfo {
  id: string;          // 技能名（= SKILL.md 所在目录名，加载时校验一致）
  name: string;        // frontmatter name
  description: string; // frontmatter description
  pluginId?: string;   // 来源插件；缺省 = 独立技能
  path: string;        // SKILL.md 绝对路径（供读取/展示）
}

export interface PluginSummary {
  // 现有字段：id/name/version/status/toolCount/error
  skills: SkillFileInfo[];   // 新增
}

export interface SkillCatalog {
  standalone: SkillFileInfo[];              // 独立技能
  plugins: PluginSummary[];                 // 插件（含各自 skills）
}
```

## 3. 加载机制（后端）

1. **扫描**：启动 / `POST /api/plugins/reload` 时
   - `runtime/skills/` → 独立技能（id = 目录名，无前缀）
   - 每个插件的 `skills/` → 插件技能（id = `plugin:skill`）
2. **解析**：读 `<skill>/SKILL.md` frontmatter（name/description）
   - 校验 `name === 目录名`，不一致则 warning 不注册（对齐规范）
   - 单技能解析失败降级为 error 条目，不影响插件整体 loaded
3. **注入 agent**：技能清单（`plugin:skill` / `skill` + description）追加进 system prompt；SKILL.md 正文由 agent 在需要时通过工具/API 按需读取（阶段内实现读取接口即可）

## 4. API

| 端点 | 说明 |
|---|---|
| `GET /api/skill-catalog` | `{ standalone, plugins }`（新） |
| `GET /api/skills/:id` | 返回 SKILL.md 全文（新，按需加载用） |
| `GET /api/plugins` | 现有，`PluginSummary.skills` 自动带出 |

## 5. 前端（技能面板重构）

三区：
1. **插件**：卡片（名称/版本/状态 + 技能 chips + MCP 工具数）
2. **独立技能**：列表（name + description，点击展开 SKILL.md 全文）
3. **独立 MCP 工具**：现有 mcp 工具列表（占位，阶段二）

## 6. 实施步骤

1. shared：`SkillFileInfo` / `SkillCatalog` / `PluginSummary.skills`
2. 后端：`skills/skillLoader.ts`（扫描+解析）+ `pluginManager` 解析插件 skills + agent 注入 + `/api/skill-catalog` + `/api/skills/:id`
3. 前端：`fetchSkillCatalog` / 面板三区 / SKILL.md 查看
4. 测试：skillLoader 单测（校验/命名空间/容错）+ 前端 typecheck
5. 阶段二：独立 MCP 工具区、附件资源消费、热更新监听

## 7. 边界

- frontmatter 仅解析 name/description（正则取前几行，不引入 YAML 库）
- `runtime/skills/` 不存在时为空（mkdir 惰性）
- 附件第一版不消费；SKILL.md 内相对路径原样展示
- 插件 manifest 兼容两种：目录约定（Claude 式）优先，有 skills 字段（Codex 式）则校验指向
