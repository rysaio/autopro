# SecOps Agent Domain Context

## Product

SecOps Agent 是面向安全运营分析的本地 Agent 控制台。它组合模型连接、技能指令、可调用工具、插件和 MCP server，并在统一的审批、审计和运行范围内执行调查与处置流程。

## Glossary

### Capability

产品对可用 Skill、Plugin 和 MCP 来源的统称。Capability 用于发现和展示，不直接决定工具权限。

### Tool

模型可以调用的执行入口。Tool 具有输入约束、类别、风险和暴露阶段，并由 Tool Registry 执行。

### Tool Manifest

Tool 的声明信息，包括名称、描述、输入、类别、风险、标签、MCP 兼容性和 `deferLoading`。

### Tool Pack

用于展示、筛选和运行范围控制的 Tool 分组。Tool Pack 不是 Skill，也不是 Plugin。

### Skill

以目录形式分发的指令包，必须包含带 YAML frontmatter 的 `SKILL.md`。Skill 为 Agent 提供工作方法，不直接执行外部动作。

### Standalone Skill

安装在运行目录 `runtime/skills/`、不属于任何 Plugin 的 Skill。

### Plugin

能力分发容器，可包含 Skill 和一个或多个 MCP Server。Plugin 不等于 Tool Pack。

### MCP Server

通过 Model Context Protocol 向宿主提供 Tool 的进程或连接。MCP Server 可以属于 Plugin；独立 MCP 在后续阶段实现。

### Capability Catalog

聚合 Standalone Skill、Plugin Skill、Plugin 和 MCP Server 状态的查询模块，为前端和 Agent Runtime 提供统一能力快照。

### Skill Catalog

管理 Skill 摘要、来源、状态和正文读取的后端模块。文件路径属于内部实现，不是公开领域数据。

### Tool Registry

管理 Tool 注册、查询、执行、审批和暴露阶段的后端模块。

### Runtime Directory

源码开发和 runnable 存放可变配置、Skill、Plugin、审计、审批与数据库数据的运行目录。两种运行方式必须保持相同的相对结构和行为。

## Relationships

- Capability 包含 Standalone Skill、Plugin 和后续的独立 MCP 来源。
- Plugin 包含零个或多个 Skill，以及零个或多个 MCP Server。
- MCP Server 提供 Tool。
- Skill 向 Agent 提供指令，Tool 向 Agent 提供执行能力。
- Tool Pack 只组织 Tool，不拥有 Skill 或 MCP Server。
- Capability Catalog 聚合来源状态，Skill Catalog 管理 Skill，Tool Registry 管理 Tool。

## Invariants

- “Skill”只表示 `SKILL.md` 指令包，不再表示 Tool 或 Tool Pack。
- Skill frontmatter 使用 YAML 解析器解析，不使用正则。
- Skill 清单只包含摘要；正文按需读取。
- Plugin Skill 只从 manifest 明确声明的目录加载。
- Tool 权限、审批和 `deferLoading` 与 Skill 加载相互独立。
- 人工修改运行文件后通过显式重载生效，无需重启。
- 源码开发与 runnable 使用相同运行目录结构和加载语义。
- 无效配置返回明确错误，不通过猜测、自动修复或多级兜底掩盖问题。

