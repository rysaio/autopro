# 能力模型重构实施计划

日期：2026-08-10

状态：待实施

定位：定义产品概念、模块职责、对外接口方向和前端验收标准。具体加载与运行机制见 `todo-skill-system-design.md`。

## 1. 产品目标

建立统一的能力视图，准确呈现三类来源：

- 独立技能：由用户安装在运行目录，不属于插件。
- 插件：能力分发容器，可包含技能和一个或多个 MCP server。
- 独立 MCP：不属于插件的 MCP 连接及其工具，后续单独实施。

能力视图负责说明来源和组成，不接管工具执行、审批或暴露阶段策略。

## 2. 统一术语

| 术语 | 含义 |
|---|---|
| Capability | 对技能、插件和 MCP 来源的产品级统称 |
| Tool | 模型可调用的执行入口 |
| Tool Manifest | 工具名称、输入、风险、类别和暴露阶段声明 |
| Tool Pack | 工具分组，仅用于展示、筛选和运行范围控制 |
| Skill | 包含 `SKILL.md` 的指令包，不等于 Tool |
| Plugin | 包含技能和 MCP server 的分发容器 |
| MCP Server | 向宿主提供工具的外部进程或连接 |

`SkillManifest` 和 `SkillPackManifest` 当前实际描述 Tool 与 Tool Pack，实施时直接改为准确命名，并同步修改全部调用方和界面文案。

## 3. 当前差距

- `PluginManager` 只消费 MCP 配置，忽略插件声明的技能目录。
- `PluginManager` 只加载第一个 MCP server，不能表达插件的完整能力。
- `PluginSummary` 只有工具数量，缺少描述、技能、MCP server 明细和局部失败状态。
- `/api/skills` 实际返回 Tool Pack，接口语义与真实 Skill 冲突。
- 前端“技能”页面实际控制 Tool，MCP 页面实际展示全部 MCP 兼容 Tool。
- 源码运行目录没有内置插件装配，runnable 才包含插件，开发与发布行为不一致。

## 4. 目标模块

### Capability Catalog

作为能力查询的深模块，聚合独立技能、插件技能、插件 MCP server 和来源状态。对调用方提供稳定摘要，不泄露文件路径和加载实现。

### Tool Registry

只负责 Tool 注册、查询、执行、审批和暴露阶段。Skill 与 Plugin 信息不进入该模块。

### Skill Catalog

负责 Skill 的索引、读取和重载。内部保存文件定位信息，对外只暴露技能摘要、来源、状态和正文读取结果。

### Plugin Manager

负责插件发现和生命周期，委托 Skill Catalog 加载技能，委托 MCP adapter 管理各 MCP server。纯技能插件必须是有效插件，不要求同时存在 MCP server。

## 5. 对外接口方向

- 工具清单继续由 tools 接口提供。
- Tool Pack 使用独立接口，不再占用 skills 语义。
- Capability Catalog 提供统一能力快照，供前端能力页面使用。
- Skill 正文通过受控读取接口提供，不随能力快照返回。
- Plugin 状态接口保留运维用途，返回技能和各 MCP server 的实际状态。
- Capability reload 提供人工文件修改后的无重启重载入口。

不保留语义错误的旧接口别名；前后端在同一实施切片中同步迁移。

## 6. 插件状态模型

插件需要表达三种状态：

- loaded：声明的能力全部加载成功。
- degraded：插件可用，但部分 Skill 或 MCP server 加载失败。
- error：插件 manifest 无效或没有任何可用能力。

每个 Skill 和 MCP server 保留独立状态与错误摘要。单项失败不得伪装为空集合，也不得抹掉其他已加载能力。

## 7. 前端能力页面

能力页面按来源组织：

1. 插件：显示名称、版本、描述、状态、技能清单和 MCP server 工具数量。
2. 独立技能：显示名称、描述和加载状态，可查看正文。
3. 独立 MCP：仅在独立 MCP 连接功能落地后展示。

当前 Tool 开关页面改名为“工具”或“运行范围”，继续负责 Tool 启停、风险和类别筛选，不与 Skill 激活混合。

页面提供“重新加载能力”命令。人工修改 Skill 或 Plugin 文件后，由用户触发重载，无需重启进程。

## 8. 实施顺序

1. 统一 Tool、Tool Pack、Skill、Plugin 术语和共享类型。
2. 完成源码与 runnable 的运行目录装配一致性。
3. 实施 Skill Catalog 和 Plugin Manager 改造。
4. 实施模型按需读取 Skill 的运行机制。
5. 提供 Capability Catalog、重载接口和状态接口。
6. 最后重构前端能力页面和工具页面。

## 9. 验收标准

- Tool、Tool Pack 和 Skill 在类型、接口、文档及界面中含义一致。
- Wazuh 的 5 个 Skill 和 Shuffle 的 3 个 Skill 均能从插件来源识别。
- 纯技能插件可加载；多 MCP server 插件可完整加载。
- 独立 Skill 与插件 Skill 使用相同结构和读取机制。
- 源码开发与 runnable 对相同运行目录内容给出一致能力快照。
- 文件修改后通过界面手动重载生效，无需重启。
- Tool 权限、审批和 `deferLoading` 行为不因能力模型重构而改变。

## 10. 本轮不做

- 自动文件监听。
- Skill 附件执行和资源解析。
- 独立 MCP 连接管理。
- per-skill 权限或启停策略。
- 为旧的错误术语和接口增加长期兼容层。
