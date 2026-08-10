# 技能系统实施计划

日期：2026-08-10

状态：待实施

定位：实现 `SKILL.md` 的发现、解析、索引、按需读取、重载和发布装配。

## 1. 产品结果

- 独立 Skill 位于运行目录的 `runtime/skills/`。
- 插件 Skill 位于插件 manifest 明确声明的技能目录。
- 两类 Skill 使用同一加载模块和校验规则，仅来源与命名空间不同。
- Agent 启动请求只获得 Skill 名称和描述，需要时再读取正文。
- 人工修改文件后通过能力重载命令生效，无需重启。

## 2. Skill 来源规则

### 独立 Skill

从固定的 `runtime/skills/` 扫描一级技能目录。每个技能目录必须包含 `SKILL.md`。

### 插件 Skill

只读取插件 manifest 的 `skills` 声明，不猜测其他目录，不增加兼容扫描路径。声明缺失表示该插件不提供 Skill。

### 标识规则

- 独立 Skill 使用目录名作为 ID。
- 插件 Skill 使用插件 ID 与目录名组成的命名空间 ID。
- frontmatter 的 name 必须存在并与目录名一致。
- 重复 ID、无效 name 或缺失 `SKILL.md` 均记为明确错误，不注册该 Skill。

## 3. 核心模块与 seam

### Skill Loader

Skill Loader 是文件系统与领域模型之间的 adapter，负责扫描指定根目录、读取 frontmatter、校验元数据并形成加载结果。

frontmatter 必须使用正式 YAML 解析器解析，再通过明确的数据约束校验。禁止使用正则解析 YAML，也不对错误字段做猜测或静默修复。

### Skill Catalog

Skill Catalog 是技能查询和正文读取的深模块，负责：

- 发布当前有效 Skill 摘要和错误条目。
- 按 ID 读取有效 Skill 正文。
- 隐藏绝对路径和文件系统细节。
- 在重载完成后一次性替换当前快照。

### Plugin Manager

Plugin Manager 读取插件 manifest，建立插件元数据，并把技能目录交给 Skill Loader。MCP server 由独立 adapter 逐个连接，全部 server 都必须被处理，不再只取第一个。

插件可以只包含 Skill、只包含 MCP server，或同时包含两者。插件只有在 manifest 无效或没有任何可用能力时进入 error。

### Agent Runtime

Agent Runtime 从 Skill Catalog 获取名称、描述和来源摘要，将其加入 system prompt。Skill 正文不常驻 prompt。

模型通过一个只读的 Skill 读取工具按 ID 获取正文。浏览器读取接口和模型读取工具复用 Skill Catalog，不各自实现文件读取。

### Capability Reload

Capability Reload 协调 Skill Catalog 刷新和 Plugin Manager 重载。重载成功后发布新快照；整体扫描失败时返回错误，不用空数据覆盖当前有效快照。

第一阶段只提供显式重载，不实现文件监听。

## 4. 数据公开原则

对外 Skill 摘要只包含：

- ID、名称和描述。
- standalone 或 plugin 来源。
- 插件 ID。
- loaded 或 error 状态及简短错误。

绝对路径、内部根目录和文件句柄只存在于后端实现，不进入共享前端类型。

Skill 正文通过单独读取动作返回，避免能力清单体积随正文增长。

## 5. 必要安全约束

- Skill 文件必须位于声明根目录内。
- 拒绝路径穿越和链接到根目录外的文件。
- 对正文大小设置明确上限，避免单个文件占满模型上下文。
- Skill 读取工具只读，不执行附件或脚本。

以上约束由 Skill Loader 和 Skill Catalog 集中实现，不在调用方重复增加防御逻辑。

## 6. 源码与 runnable 装配

### 源码开发

开发启动流程在后端启动前准备 `src/runtime/skills/` 和 `src/runtime/plugins/`。内置插件通过统一的开发运行时装配步骤放入 runtime，确保源码运行能够发现与 runnable 相同的插件 manifest、Skill 和 MCP server。

开发装配只管理内置插件，不覆盖用户自行安装的其他插件。

### runnable

构建流程创建 `runtime/skills/`，复制需要随包发布的独立 Skill，并继续把插件 manifest、Skill、MCP 配置和编译产物复制到 `runtime/plugins/`。

启动脚本负责补齐可能被压缩工具丢弃的空运行目录。

### 一致性要求

源码与 runnable 使用相同的相对运行目录、Skill 结构、插件结构、加载规则和重载动作。差异只允许存在于构建产物来源，不允许存在于产品行为。

## 7. 实施切片

### 切片一：术语和接口迁移

- 将当前 Tool 与 Tool Pack 类型改为准确名称。
- 将当前 `/api/skills` 迁移为 Tool Pack 接口。
- 同步修改后端、前端、测试和界面文案。

### 切片二：Skill Loader 与 Skill Catalog

- 引入 YAML 解析依赖和 frontmatter 数据校验。
- 实现独立 Skill 与插件 Skill 加载。
- 实现命名空间、错误条目和正文读取。
- 完成模块级测试。

### 切片三：Plugin Manager

- 消费 manifest 的 skills 声明。
- 支持纯技能插件和多个 MCP server。
- 记录插件、Skill 和 MCP server 的实际状态。
- 保证重载后 Tool Registry 与 Skill Catalog 同步。

### 切片四：Agent 按需激活

- 将 Skill 摘要加入 system prompt。
- 注册只读 Skill 读取工具。
- 验证正文只在模型明确读取后进入上下文。

### 切片五：运行目录与重载

- 完成开发运行时装配。
- 完成 runnable 构建和启动目录补齐。
- 增加能力重载动作和端到端验证。

### 切片六：前端能力页面

- 接入 Capability Catalog。
- 展示插件和独立 Skill。
- 提供正文查看和手动重载。
- 将 Tool 范围控制与 Skill 展示彻底分离。

## 8. 测试重点

- YAML frontmatter 正确解析与数据校验。
- 缺失文件、无效字段、重复 ID 和命名空间冲突。
- 插件单 Skill 失败时其他能力仍可用。
- 纯技能插件、多 MCP server 和插件重载。
- Skill 正文按需读取且不泄露文件路径。
- system prompt 只包含摘要，不包含正文。
- 源码和 runnable 的能力快照一致。
- UI 手动重载后展示新文件内容且进程不重启。

## 9. 完成标准

- 8 个现有插件 Skill 全部进入 Capability Catalog。
- 新增独立 Skill 后，手动重载即可发现并读取。
- 修改 Skill 后，手动重载即可更新摘要和正文。
- Plugin Manager 不再忽略 skills，也不再只加载第一个 MCP server。
- Agent 能根据摘要选择 Skill，并通过读取工具获得正文。
- 全量类型检查、后端测试、插件测试、前端测试和 runnable 构建通过。

## 10. 实施原则

- 优先完成可见、可加载、可读取、可重载的产品闭环。
- 不为假设场景增加兼容路径、自动修复或多级兜底。
- 错误必须明确暴露，不把失败伪装成空数据。
- 必要故障隔离集中在模块内部，调用方只依赖稳定接口。
- 第一阶段不实现附件消费、文件监听和独立 MCP。
