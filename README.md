# SecOps Agent 优化版 v2.0

## 算法创新说明

本研究在传统安全编排自动化与响应(SOAR) Agent架构基础上，提出两项关键算法创新，显著降低大语言模型(LLM)推理成本：

### 创新一：确定性本地预路由 (Deterministic Local Pre-routing)

默认执行路径不再无条件串行调用 triage 和 deep 两个模型阶段。服务先在本地根据最新用户意图、必要的最近对话、当前工具 manifest、`enabledTools` 和权限策略生成路由决策，然后启动一次最终模型执行。

```text
最新用户意图 + 有效对话上下文 + 工具目录 + 启用集合 + 权限策略
                              ↓
                    确定性本地路由决策
                              ↓
                  一次最终模型执行（含工具循环）
```

每个 `AgentRun.routing` 都记录：

- 最终选择的 manifest 工具 ID
- 命中的路由分组
- 置信度等级和分数
- 可复现的选择原因
- 是否使用额外模型阶段及其原因

`enabledTools` 在所有模式下都是上限：路由输出必须与它取交集，显式空数组表示不向模型暴露任何工具。Action 工具还必须同时满足用户已启用、意图相关、部署级 `actionLevel` 允许和请求级 `permissionMode` 允许；可见性本身不会绕过执行时的审批。

高置信度单域请求直接选择对应分组。跨域请求由本地规则合并分组，不自动增加远程路由调用。未知或低置信度请求使用明确的本地回退，只考虑已启用、非 action 的常驻工具，并在路由结果中记录低置信度；它不会静默恢复双阶段执行。

旧执行路径仅作为基准/回滚保留：`single` 为旧单阶段基线（不预路由，一次最终模型执行），`layered` 为旧双阶段临时回滚：

```powershell
$env:SECOPS_AGENT_ROUTING_MODE = "single"
$env:SECOPS_AGENT_ROUTING_MODE = "layered"
```

未设置或设为其他值时使用 `deterministic`。回滚/基线模式同样严格应用 `enabledTools`、action 策略和原始消息保留规则。

每个工具的 `deferLoading` 声明继续用于常驻/按需暴露：`false` 表示常驻，`true` 表示只有命中对应路由分组时才加载。插件通过 MCP `_meta.deferLoading` 透传默认值；插件工具缺失或声明无效时默认 `true`（按需），避免未知插件工具因缺少元数据而永久常驻。用户可通过 API 覆盖任意已注册工具：

用户可以通过 API 覆盖任意已注册工具：

```http
GET /api/tools/visibility

PUT /api/tools/visibility/wazuh.alerts.search
Content-Type: application/json

{ "deferLoading": false }
```

上述覆盖会让 `wazuh.alerts.search` 从按需工具变成常驻工具。清除覆盖后恢复工具原始声明：

```http
DELETE /api/tools/visibility/wazuh.alerts.search
```

覆盖持久化在 `runtime/config/toolVisibility.json`，服务重启或插件 reload 后仍然生效。
`GET /api/tools` 返回应用覆盖后的最终 `deferLoading` 状态。

任意已安装插件工具不依赖第一方名称或硬编码前缀，也可被确定性路由发现。插件可在
`.codex-plugin/plugin.json` 声明 `routing: { group, keywords }`，或在 MCP 工具
`_meta.routing` 中声明同样的字段（per-tool 优先）；主服务只接受校验通过的非空字符串，
缺失或无效时回退到从工具 id、name、description、tags（插件 keywords、`_meta.tags`
与 MCP annotations 派生标签）中提取的通用路由提示。未命中第一方分类的 deferred
工具只有在请求匹配其路由提示时才会被选中，不进入不相关的高置信度请求；路由索引在
每次 agent run 前重建，插件 reload 后新装/卸载立即生效。

### 创新二：语义工具缓存 (Semantic Tool Cache)

缓存是单服务实例生命周期内、容量受限的精确结果复用，不缓存模型回答，也不表示跳过模型调用。目前只有内置只读工具 `threat.intel.lookup` 通过 manifest 显式启用，TTL 为 5 分钟；其余工具缺少声明时默认绕过，所有 action 工具始终实时执行。

读取顺序固定为：输入校验、权限与审批判定、缓存读取、真实 handler、成功结果写入。失败、待审批、拒绝、可恢复指引和 action 结果不会写入缓存，成功 action 会全局失效现有只读结果。

缓存键使用 SHA-256，输入包括工具 ID/版本、数据源、workspace 以及递归按键排序的参数；数组顺序和值语义保持不变。缓存最多保留 256 条，采用确定性 LRU 淘汰，并在读写时清理过期条目。服务重启后缓存为空。

每次命中仍生成新的 invocation ID 和 artifact ID。调用审计记录原 invocation、原创建时间、缓存年龄和 hit/miss/bypass；指标分别报告真实 handler 次数、淘汰/过期/失效数量及按原 handler 实测耗时计算的避免工具耗时，不宣称固定 token 节省。

### 创新三：模型客户端复用与连接生命周期观测 (Model Client Reuse)

同一活动连接配置下的连续与并发 agent run 复用同一个 provider client（AI SDK 的 LanguageModel 是无状态工厂产物，可安全共享），不再每次 run 重建。缓存键为连接 id + 配置指纹（provider/model/baseUrl/apiKey 的 SHA-256 摘要，指纹不可逆）。

配置变更即失效：更新连接、删除连接、从文件 reload 都会使旧 client 失效；若旧 client 仍被活跃 run 使用，则延迟到该 run 结束再释放（引用计数）。provider 暴露清理操作时（可选 disposeModel）才真正关闭旧 client。

观测与模型请求时长完全分开：`GET /api/health` 的 `modelClients` 段报告创建/复用/失效/失败/释放计数（仅连接 id，永不包含 API key 或授权头）；每次 run 的 `metrics.modelClient` 报告该次是否复用。

`GET /api/cache/usage` 提供适合前端轮询的进程级精简摘要：工具结果缓存的 lookup、命中率与容量，以及模型客户端的创建、复用率和活跃 run。尚无样本时命中率/复用率为 `null`，响应禁止 HTTP 缓存，且不包含密钥、配置指纹或缓存键。

### 创新四：有界异步持久化队列 (Bounded Async Persistence Queue)

逐事件持久化通过有界、有序、异步批处理队列移出 SSE 与工具执行热路径：事件发射与工具执行不再等待单次存储写入。每次 run 一个 FIFO 队列，run 内事件（审批、工具调用、工件、审计、消息、终止事件）严格按序写入；队列容量与批大小有界且可配置（保守默认：容量 512、批大小 32、刷新窗口 20ms）。

队列满时应用文档化的有界背压：入队等待至多 `SECOPS_PERSIST_SATURATION_WAIT_MS`（类比 Kafka producer 的 `max.block.ms`），超时后以失败呈现并通过指标与 run 审计状态记录，关键记录不静默丢弃。存储失败通过指标与审计状态呈现，不影响已完成的模型结果。

run 完成与服务器关闭执行有界排空（默认 5s 超时），超时显式报告剩余工作而非无限等待。指标区分队列等待、批写入时长、失败、深度、饱和与排空时长（`metrics.persistence`）。设计依据为有界通道 + 背压 + 干净关闭的业界标准语义（如 tokio mpsc 的 bounded channel 与 clean shutdown）。

### 技术架构

```text
请求 → 本地预路由 → 最终模型执行 → 输入校验 → 权限/审批 → ToolCache.Get() → 真实 handler → ToolCache.Set() → 最终响应
                         ↓                                      ↓ 命中                    ↓
                    模型调用指标                       新 invocation + 新 artifact      工具与缓存指标
```

## 源码开发流程

源码开发和 `runnable` 发布包是两套独立流程。源码开发只使用 `src/` 下的 TypeScript、Vite 和开发依赖；不要直接修改 `runnable/app` 中的编译文件。

### 1. 安装开发依赖

```powershell
cd src
npm ci
```

Node.js 建议使用 24 LTS。需要覆盖默认环境变量时，将 `.env.example` 复制为 `.env`；当前后端只加载 `.env`，不加载 `.env.local`：

```powershell
Copy-Item .env.example .env
```

模型连接不配置在 `.env` 中，统一使用 `runtime/config/model.json` 和模型配置 API。完整用法见下方「配置」章节。

### 2. 启动源码服务

在 `src/` 目录执行：

```powershell
npm run dev
```

该命令先启动 Fastify 后端并等待 `/api/health` 可用，再启动 Vite 前端，避免两个开发编译器同时冷启动时后端未进入监听状态：

- Vite 前端：http://localhost:5317
- Fastify 后端：http://127.0.0.1:4317

前端开发服务器会把 `/api` 请求代理到 4317 端口。若需要分别观察日志，请按顺序在两个终端启动：

```powershell
# 终端 1（src/）
npm run dev:server

# 终端 2（src/，确认后端已监听后再执行）
npm run dev:web
```

如果本机已有服务占用后端端口，可以用独立的临时端口和内存会话进行源码调试：

```powershell
# 终端 1（src/）
$env:PORT = "4327"
$env:SECOPS_DURABLE_SESSIONS = "off"
npm run dev:server

# 终端 2（src/）
$env:VITE_API_BASE_URL = "http://127.0.0.1:4327"
npm run dev:web
```

这种方式不会读取或修改 `src/runtime/pgdata`。`VITE_API_BASE_URL` 必须在 Vite 启动前设置；修改后需要重启 Vite 开发服务。

### 3. 源码验证

```powershell
# 前端测试和类型检查
npm test -w @secops-agent/web

# 全项目类型检查
npm run typecheck

# 全项目测试
npm test
```

开发运行时产生的会话、审计日志和 PGlite 数据属于运行时数据，不应复制到源码或提交到版本库。构建前端/后端时只修改各自的 `dist/` 输出目录。

#### 真实模型回归基准（Issue #11）

发布前用仓库真实模型连接跑版本化基准，分别以三种路由模式启动服务后执行（密钥只由 `runtime/config/model.json` 读取，命令与报告不打印、不持久化凭据）：

```powershell
# 终端 1（src/，分别用 single / layered / deterministic 启动三次）
$env:SECOPS_AGENT_ROUTING_MODE = "deterministic"
npm run dev:server

# 终端 2（src/）
npm run benchmark:agent -- --mode deterministic --scenario all --runs 3 --json > benchmark-deterministic.json

# 三种模式跑完后合并出发布门禁报告
npm run benchmark:compare -- benchmark-single.json benchmark-layered.json benchmark-deterministic.json
```

场景覆盖：简单无工具、一次只读工具、TTL 内重复只读、长对话、通用插件 reload 后路由。最近一次真实 DeepSeek 结果与发布门禁见 [docs/done-11-benchmark.md](docs/done-11-benchmark.md)：deterministic 中位首文本约为旧单阶段基线的 0.80x、中位总耗时约为 0.86x，简单请求仅 1 次模型调用。

### 4. 停止源码服务

在运行 `npm run dev` 的终端按 `Ctrl+C`。如果终端已关闭但开发进程仍在监听默认端口，可在 `src/` 执行：

```powershell
npm run stop:dev
```

使用自定义端口时，应在对应终端按 `Ctrl+C` 停止进程。

## 配置

### 模型配置（连接注册表：`runtime/config/model.json` + 只写凭据文件 `.credentials.yaml`）

模型连接不依赖环境变量——连接与活动连接的唯一事实来源是 `runtime/config/model.json`，**启动前后入口一致**（改动同一个文件，启动时读取 / 启动后 reload 生效）。路径相对于服务工作目录：源码开发时为 `src/runtime/config/model.json`，发布包运行时为 `runnable/app/runtime/config/model.json`；仓库根目录不需要单独创建 `runtime/`。

- **密钥只写**：API Key 明文只写入工作区根目录的 `.credentials.yaml`（文件权限 0600）；`model.json` 只保存 `apiKeyCredentialId` 凭据引用，API 响应只回传脱敏描述符（如 `sk-***abc`）
- **默认模板**：发布包预置 `runtime/config/model.json`，默认 `provider=deepseek` / `model=deepseek-v4-flash` / `baseUrl=https://api.deepseek.com`，无 API Key。源码开发执行 `npm run dev` 时，如果文件不存在会自动创建同一份空模板；已有文件不会被覆盖
- **先配置再启动**：直接编辑该文件，启动时读取
- **启动后配置**（均无需重启）：
  - 直接编辑该文件 → 调用 `POST /api/model-config/reload` 从文件重新加载
  - 通过 API 增删改/切换（写文件并即时生效）

`runtime/config/model.json` 结构（多连接注册表 + 活动连接；只存凭据引用）：

```json
{
  "connections": [
    {
      "id": "conn-1",
      "name": "qwen",
      "provider": "qwen",
      "model": "qwen3.6-max-preview",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "apiKeyCredentialId": "cred_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
    }
  ],
  "activeConnectionId": "conn-1"
}
```

`.credentials.yaml` 结构（密钥只写文件，mode 0600）：

```yaml
credentials:
  cred_xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:
    secret: your-key
    description: Model API key for qwen
    createdAt: "2026-06-19T00:00:00.000Z"
```

模型配置 API：

```bash
GET    /api/model-config                        # 查看连接列表（apiKey 永不回传，仅 apiKeySet + apiKeyMasked 脱敏描述符）
POST   /api/model-config                        # 新建连接（首个自动设为活动）
PUT    /api/model-config/:id                    # 更新连接（省略字段保留旧值；apiKey 空串=清除）
DELETE /api/model-config/:id                    # 删除连接（删除活动连接自动转移）
POST   /api/model-config/:id/activate           # 切换活动连接
POST   /api/model-config/reload                 # 从文件重新加载（编辑 model.json 后调用）
```

```bash
curl -X POST http://127.0.0.1:4317/api/model-config \
  -H "Content-Type: application/json" \
  -d '{"name":"qwen","provider":"qwen","model":"qwen3.6-max-preview","baseUrl":"https://dashscope.aliyuncs.com/compatible-mode/v1","apiKey":"your-key"}'
# 响应中的 apiKeyMasked 为脱敏描述符；明文只写入 .credentials.yaml，model.json 仅保存凭据引用
```

### 插件配置（`runtime/plugins/`）

wazuh / shuffle 等集成以 Codex 插件形态提供（`runtime/plugins/<name>/`，manifest 可声明 `skills` 与 `mcpServers`）：

- 发布包预置 `wazuh-secops`、`shuffle-secops` 两个插件；**安装新插件** = 把插件目录复制到 `runtime/plugins/`
- 服务启动时自动扫描加载；运行中安装后调用 `POST /api/plugins/reload` 即可生效（无需重启）
- `GET /api/plugins` 查看插件、每个 MCP server 与技能/工具数量的实际状态
- 插件动作工具的审批/审计由主服务统一把关

### 技能目录（`runtime/skills/`）

独立 Skill 位于 `runtime/skills/<name>/SKILL.md`；插件 Skill 只从插件 manifest 的 `skills` 声明加载。`SKILL.md` 使用 YAML frontmatter，`name` 必须与目录名一致并提供 `description`。技能页面可查看来源、错误和正文，并可手动重载。

Agent 的 system prompt 只包含有效 Skill 的 ID、名称和描述；正文通过只读 `secops_skill_read` 工具按需获取，不常驻模型上下文。Skill 清单与正文接口不会返回文件路径。

每个技能有独立功能开关（持久化在 `runtime/config/skillVisibility.json`）：关闭后技能从
Agent 的提示与 `secops_skill_read` 中排除（对模型不可见），界面仍可预览正文。

```text
GET  /api/skills
GET  /api/skills/:id
POST /api/skills/reload
GET  /api/skills/visibility
PUT  /api/skills/visibility/:id      # body: { "enabled": false }
```

### 独立 MCP 服务（`runtime/config/mcp.json`）

不属于插件的 MCP 服务在前端“工具 > MCP 服务”中管理，支持 stdio 与 Streamable HTTP。新增、编辑、启停、重连和删除会即时更新工具注册，无需重启；也可以直接编辑配置文件后执行 `POST /api/mcp/servers/reload`。

服务端只向前端返回环境变量和请求头的键名，值仅保存在本地配置文件与服务端内存中。未声明只读语义的第三方 MCP 工具按 action/high 处理，继续经过统一审批策略。

```text
GET    /api/mcp/servers
POST   /api/mcp/servers
PUT    /api/mcp/servers/:id
DELETE /api/mcp/servers/:id
POST   /api/mcp/servers/:id/reconnect
POST   /api/mcp/servers/reload
```

### 工具权限模型（全局三态）

**工具只声明属性（toolClass / risk），放行由全局权限模式决定**——工具/插件不能自声明权限，`defaultPermission` 已彻底移除。放行策略由用户通过全局模式控制，作用于所有工具：

| 全局模式 | 语义 |
|---|---|
| `ask` | 非 action（读取类）自由调用；**所有 action 工具均需审批** |
| `auto` | 自动运行所有工具；**可选开关**：risk=high 的 action 默认仍入审批（`autoApproveHighRisk`，默认 true 保守），用户可关闭实现全自动 |
| `deny` | 只读：仅非 action 可调用，action 一律拒绝 |

- 请求级 `permissionMode`（agent run / MCP 调用端点传入，三态）决定当次放行；部署级 `actionLevel`（observe/sandbox/full-access）是闸门——`full-access` 无视请求级模式直接放行 action，`observe` 下所有 action 拒绝
- 审批通过的 action 以重放方式执行（不二次审批；`deny` 只读模式下重放也拒绝）；非 action 在任何模式下均可自由调用
- 插件 `_meta` 不再传递/信任 `permission`；`/api/mcp/tools/:name/call` 客户端自报 `permissionMode` 的滥用面收窄

### 运行时设置

- `GET /api/settings` 查看当前设置
- `POST /api/settings/action-level` 切换自动化级别（`observe` 只读 / `sandbox` 沙箱 / `full-access` 全权），持久化到 `runtime/config/settings.json`
- `GET /api/settings/auto-approve-high-risk` 查看 auto 模式下高危 action 是否仍需审批（默认 `true` 保守）
- `PUT /api/settings/auto-approve-high-risk` 切换该开关（body `{ "autoApproveHighRisk": false }` 关闭后 auto 模式全自动执行），持久化并即时生效

### 工具暴露级别

用户覆盖持久化在 `runtime/config/toolVisibility.json`，键为工具 manifest id，值为
`deferLoading`。覆盖值优先于内置或插件声明，插件 reload 后仍会重新应用。

```bash
GET    /api/tools/visibility
PUT    /api/tools/visibility/:id       # body: { "deferLoading": false }
DELETE /api/tools/visibility/:id       # 清除覆盖，回退到工具声明值
```

`GET /api/tools` 返回应用覆盖后的最终 `deferLoading` 状态。暴露级别只控制模型上下文中的
工具可见性，不改变工具执行权限或审批策略。

### 环境变量参考（`.env`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SECOPS_MODEL_CONFIG_PATH` | `runtime/config/model.json` | 模型配置文件路径（只存凭据引用） |
| `SECOPS_CREDENTIALS_PATH` | `.credentials.yaml` | 只写凭据文件（API Key 明文，mode 0600） |
| `SECOPS_SKILLS_DIR` | `runtime/skills` | 独立 Skill 目录 |
| `SECOPS_MCP_CONFIG_PATH` | `runtime/config/mcp.json` | 独立 MCP 服务配置文件 |
| `SECOPS_TOOL_VISIBILITY_PATH` | `runtime/config/toolVisibility.json` | 工具暴露级别用户覆盖文件 |
| `SECOPS_SKILL_VISIBILITY_PATH` | `runtime/config/skillVisibility.json` | 技能功能开关文件（禁用技能对模型不可见） |
| `SECOPS_PLUGINS_DIR` | `runtime/plugins` | 插件目录 |
| `SECOPS_ACTION_LEVEL` | `sandbox` | 默认自动化级别（observe/sandbox/full-access） |
| `SECOPS_AGENT_ROUTING_MODE` | `deterministic` | Agent 路由模式；`single`=旧单阶段基准，`layered`=旧双阶段临时回滚，`deterministic`=新默认 |
| `SECOPS_RUNTIME_CONFIG_PATH` | `runtime/config/settings.json` | 运行时设置文件 |
| `SECOPS_SANDBOX_ROOT` | `runtime/sandbox` | 沙箱目录 |
| `SECOPS_AUDIT_LOG_PATH` | `runtime/audit/events.jsonl` | 审计日志 |
| `SECOPS_APPROVAL_STORE_PATH` | `runtime/approvals/pending.json` | 审批存储 |
| `SECOPS_DATA_DIR` / `SECOPS_DURABLE_SESSIONS` | `runtime/pgdata` / `on` | 会话持久化（`memory://` 内存 / `off` 禁用） |
| `SECOPS_ALLOWED_HOSTS` / `SECOPS_ALLOWED_ORIGINS` | localhost,127.0.0.1,::1 / http://localhost:5317,… | Host/Origin 访问控制 |
| `SECOPS_API_TOKEN` | 空 | API Bearer 令牌（设置后所有 API 需携带） |
| `SECOPS_AGENT_RUN_TIMEOUT_MS` | `300000` | 单次 Agent 模型与工具循环的服务端硬超时（毫秒） |
| `SECOPS_PERSIST_QUEUE_CAPACITY` | `512` | 持久化队列容量上限（Issue #10） |
| `SECOPS_PERSIST_BATCH_SIZE` | `32` | 持久化队列单批最大操作数 |
| `SECOPS_PERSIST_FLUSH_INTERVAL_MS` | `20` | 批刷新合并窗口（毫秒） |
| `SECOPS_PERSIST_DRAIN_TIMEOUT_MS` | `5000` | run 完成/服务器关闭的有界排空超时（毫秒） |
| `SECOPS_PERSIST_SATURATION_WAIT_MS` | `1000` | 队列饱和时的有界背压等待（毫秒） |
| `PORT` / `SECOPS_BIND_HOST` | `4317` / `127.0.0.1` | 后端监听地址 |
| `SECOPS_DEMO_MODE` | `true` | Wazuh/Shuffle 使用 mock 数据（无真实端点也可运行） |
| `WAZUH_*` / `SHUFFLE_*` | — | 插件端点与凭据配置（`SECOPS_DEMO_MODE=true` 时可省略） |

## 构建可运行包

在源码目录执行构建：

```powershell
cd src
npm ci
npm run build:runnable
```

`build:runnable` 会先编译后端和前端，然后重新生成整个 `runnable/app` 目录：

- 复制后端 `dist`、前端 `dist` 和静态服务器
- 复制 wazuh/shuffle 插件到 `runtime/plugins/`（插件模式，启动自动加载）
- 生成生产版 `package.json` 和 `package-lock.json`
- 执行 `npm ci --omit=dev`，将运行时依赖安装到发布目录
- 创建 `.env` 和完整的 PGlite 目录结构
- 从 `src/scripts/templates/` 生成 `runnable/start.bat` 和 `runnable/stop.bat`

每次构建都会清空旧的 `runnable/app`，因此不会保留旧的 PGlite 数据、依赖或配置。需要保留的环境变量应在构建完成后修改 `runnable/app/.env`，或在模板配置中维护。

发布包运行时只需要目标机器安装一次 Node.js（建议 Node.js 24 LTS）。构建完成后，运行时不需要 TypeScript、Vite 等开发依赖，也不需要联网安装 npm 包。

### 启动方式

1. 确认目标机器已安装 Node.js 24 LTS
2. 双击 `runnable/start.bat` 启动服务
3. 前端访问：http://localhost:5317
4. 后端 API：http://127.0.0.1:4317
5. 双击 `runnable/stop.bat` 停止服务

### 插件（wazuh / shuffle 等）热插拔

wazuh 与 shuffle 工具不再编译进主服务，改为 Codex 插件模式：每个插件是一个目录，含 `.codex-plugin/plugin.json`（manifest）与 `.mcp.json`（MCP server 启动配置），主服务以 MCP client 方式加载其工具。

- **内置插件**：`wazuh-secops`、`shuffle-secops` 随发布包预置在 `runtime/plugins/`（源码开发时在 `plugins/` 下 `npm run build -w @secops-agent/wazuh-secops` 等构建后复制到 `runtime/plugins/`，或直接以 `SECOPS_PLUGINS_DIR` 指向源码插件目录）
- **安装新插件**：把插件目录复制到 `runtime/plugins/<name>/`（含 manifest 与 `.mcp.json`）
- **MCP 连接方式**：`.mcp.json` 同时支持 stdio（`command`/`args`）和 streamable-http（`type: http` 或 `streamable-http` + `url`）；HTTP 插件可声明 `headers`/`http_headers`（支持 `${ENV_VAR}` 插值）、`env_http_headers` 和 `bearer_token_env_var`
- **生效方式**：服务启动时自动扫描加载；运行中安装后调用一次 `POST /api/plugins/reload` 即可 reach（无需重启），`GET /api/plugins` 可查看加载状态与工具数
- **审批归属**：插件动作工具的审批/审计仍由主服务统一把关（插件侧全放行，主服务 `decidePolicy` 决定是否执行）

```bash
curl -X POST http://127.0.0.1:4317/api/plugins/reload
curl http://127.0.0.1:4317/api/plugins
```

### 文件结构

```
runnable/
├── start.bat          # 启动脚本
├── stop.bat           # 停止脚本
└── app/
    ├── .env           # 环境配置
    ├── package.json   # 生产依赖
    ├── package-lock.json
    ├── node_modules/  # 已安装的生产依赖
    ├── static-server.mjs  # 静态服务入口
    ├── apps/
    │   ├── server/dist/   # 后端编译产物
    │   └── web/dist/      # 前端编译产物
    └── runtime/       # 运行时数据目录
        ├── config/    # 运行时配置（model.json、settings.json、toolVisibility.json）
        └── plugins/   # 插件目录（wazuh-secops、shuffle-secops 预置于此）
```
