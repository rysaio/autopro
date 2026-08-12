# SecOps Agent Domain Context

SecOps Agent 是面向安全运营分析的本地 Agent 控制台。它组合模型连接、技能、可调用工具、插件和 MCP server，并在统一的审批、审计和运行范围内执行调查与处置流程。

## Language

**Capability**:
产品对可用 Skill、Plugin 和 MCP 来源的统称。Capability 用于发现和展示，不直接决定工具权限。
_Avoid_: Catalog、Registry

**Tool**:
模型可以调用的执行入口。Tool 具有输入约束、类别、风险和暴露阶段。
_Avoid_: Function、Command

**Tool Pack**:
用于展示、筛选和运行范围控制的 Tool 分组。Tool Pack 不是 Skill，也不是 Plugin。
_Avoid_: Skill、Plugin

**Skill**:
以目录形式分发的指令包，包含技能说明和元数据。Skill 为 Agent 提供工作方法，不直接执行外部动作。
_Avoid_: Tool、Tool Pack、Plugin

**Standalone Skill**:
不属于任何 Plugin 的 Skill。
_Avoid_: Built-in Skill

**Plugin**:
能力分发容器，可包含 Skill 和/或 MCP Server。Plugin 以目录形式分发，不等于 Tool Pack。
_Avoid_: Package、Tool Pack

**MCP Server**:
通过 Model Context Protocol 向宿主提供 Tool 的进程或连接。MCP Server 可以随 Plugin 提供，也可以独立配置。
_Avoid_: Connector、Plugin

## Relationships

- 一个 **Capability** 可以包含 **Standalone Skill**、**Plugin** 和独立 **MCP Server**。
- 一个 **Plugin** 可以包含零个或多个 **Skill**，以及零个或多个 **MCP Server**。
- 一个 **MCP Server** 提供 **Tool**。
- **Skill** 向 Agent 提供工作方法，**Tool** 向 Agent 提供执行能力。
- **Tool Pack** 只组织 **Tool**，不拥有 **Skill** 或 **MCP Server**。

## Resolved Ambiguities

- “Skill”是指令包，不是 Tool 或 Tool Pack。
- “Plugin”是能力分发容器，不是 Tool Pack。
- “Capability”是发现和展示概念，不是权限概念。
- “MCP Server”可以由 Plugin 提供，也可以独立配置；两者都是 Capability 来源。
