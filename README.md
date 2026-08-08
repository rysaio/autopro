# SecOps Agent 优化版 v2.0

## 算法创新说明

本研究在传统安全编排自动化与响应(SOAR) Agent架构基础上，提出两项关键算法创新，显著降低大语言模型(LLM)推理成本：

### 创新一：分层工具路由 (Layered Tool Routing)

这个改进把“工具何时暴露给模型”从路由器硬编码，改成了“工具声明默认值 + 用户运行时覆盖”。

**改进前**

路由器主要依赖工具名称和插件前缀分类，例如 `wazuh.*`、`shuffle.*`：

- 已知插件可以进入对应 deep 类别
- 未知第三方插件会落入 `core-triage`
- 这些工具在 triage 阶段可能被全部发送给模型，导致 token 优化失效
- 用户无法调整单个工具的暴露阶段

**改进后**

每个工具通过 manifest 的 `deferLoading` 字段声明暴露阶段：

- `false`：常驻工具，triage 和 deep 都可见
- `true`：按需工具，triage 不可见，只在 deep 阶段按推断类别加载

默认策略如下：

- Core 工具：`false`，继续承担分诊
- 报告和动作工具：`true`
- Wazuh、Shuffle 内置插件工具：`true`
- 第三方 MCP 工具未声明时：`false`，保持兼容性

插件通过 MCP `_meta.deferLoading` 向主服务透传声明。运行时工具集合按以下流程生成：

```text
工具声明 + 用户覆盖
        ↓
triage = 所有 deferLoading=false 的工具
        ↓
根据用户问题推断 Wazuh / Shuffle / Reporting 等类别
        ↓
deep = 所有常驻工具 + 命中类别的 deferLoading=true 工具
```

动作工具仍固定加入 deep 的 `sandbox-actions` 类别，因此不会因为用户措辞没有命中关键词而不可达。

用户可以通过 API 覆盖任意已注册工具：

```http
GET /api/tools/visibility

PUT /api/tools/visibility/wazuh.alerts.search
Content-Type: application/json

{ "deferLoading": false }
```

上述覆盖会让 `wazuh.alerts.search` 从按需工具变成常驻工具，立即进入 triage。清除覆盖后恢复工具原始声明：

```http
DELETE /api/tools/visibility/wazuh.alerts.search
```

覆盖持久化在 `runtime/config/toolVisibility.json`，服务重启或插件 reload 后仍然生效。
`GET /api/tools` 返回应用覆盖后的最终 `deferLoading` 状态。

**改进效果**

- 第三方插件不再依赖主服务增加硬编码前缀
- triage 只携带真正需要常驻的工具，降低 tool schema token 消耗
- deep 只增加当前类别需要的按需工具，减少无关工具的注意力干扰
- 用户可以根据实际工作流提升或延迟任意工具
- 插件 reload 后覆盖不会丢失
- 暴露级别与执行权限完全独立：工具可见不代表可以执行，审批、风险和 `actionLevel` 策略保持不变

### 创新二：语义工具缓存 (Semantic Tool Cache)

**问题**：LLM在安全调查过程中频繁重复调用相同工具（如多次查询同一IOC），每次调用消耗：
- 工具调用+结果的LLM推理token
- 网络请求延迟
- 后端API配额

**方案**：基于"工具名+参数哈希"的语义缓存机制：

| 类别 | TTL | 说明 |
|------|-----|------|
| perception | 5分钟 | 资产、IOC、威胁情报查询结果稳定 |
| reasoning | 1分钟 | 检测规则、MITRE搜索可短时复用 |
| evidence | 30秒 | 报告生成短时有效 |
| action | 不缓存 | 写操作/执行动作必须实时 |

**缓存键生成**：参数排序后MD5哈希，确保语义等价的调用命中同一缓存。

**缓存失效策略**：
- 基于TTL的自动过期
- 动作执行后全局失效（状态变更可能影响感知结果）
- 支持按工具名前缀定向失效

**效果**：典型工作流中可节省约800 tokens（约4次重复调用），缓存命中率随使用时间增长而提升。

### 技术架构

```
请求 → Phase 1: Triage (常驻工具) → 意图推断 → Phase 2: Deep Dive (常驻 + 按需工具)
                ↓                                    ↓
           ToolCache.Get()                     ToolCache.Set()
                ↓                                    ↓
           命中→返回缓存结果                    结果写入缓存
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

### 4. 停止源码服务

在运行 `npm run dev` 的终端按 `Ctrl+C`。如果终端已关闭但开发进程仍在监听默认端口，可在 `src/` 执行：

```powershell
npm run stop:dev
```

使用自定义端口时，应在对应终端按 `Ctrl+C` 停止进程。

## 配置

### 模型配置（唯一事实来源：运行目录下的 `runtime/config/model.json`）

模型配置不依赖环境变量——唯一事实来源是运行目录下的明文文件 `runtime/config/model.json`，**启动前后入口一致**（改动同一个文件，启动时读取 / 启动后 reload 生效）。路径相对于服务工作目录：源码开发时为 `src/runtime/config/model.json`，发布包运行时为 `runnable/app/runtime/config/model.json`；仓库根目录不需要单独创建 `runtime/`。

- **默认模板**：发布包预置 `runtime/config/model.json`，默认 `provider=deepseek` / `model=deepseek-v4-flash` / `baseUrl=https://api.deepseek.com`，`apiKey` 为空——填入 key 即可使用。源码开发执行 `npm run dev` 时，如果文件不存在会自动创建同一份空 key 模板；已有文件不会被覆盖
- **先配置再启动**：直接编辑该文件，启动时读取
- **启动后配置**（均无需重启）：
  - 直接编辑该文件 → 调用 `POST /api/model-config/reload` 从文件重新加载
  - 通过 API 增删改/切换（写文件并即时生效）

`runtime/config/model.json` 结构（多连接注册表 + 活动连接）：

```json
{
  "connections": [
    {
      "id": "conn-1",
      "name": "qwen",
      "provider": "qwen",
      "model": "qwen3.6-max-preview",
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "apiKey": "your-key"
    }
  ],
  "activeConnectionId": "conn-1"
}
```

模型配置 API：

```bash
GET    /api/model-config                        # 查看连接列表（apiKey 永不回传，仅 apiKeySet）
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
```

### 插件配置（`runtime/plugins/`）

wazuh / shuffle 等工具以 Codex 插件形态提供（`runtime/plugins/<name>/`，含 `.codex-plugin/plugin.json` 与 `.mcp.json`）：

- 发布包预置 `wazuh-secops`、`shuffle-secops` 两个插件；**安装新插件** = 把插件目录复制到 `runtime/plugins/`
- 服务启动时自动扫描加载；运行中安装后调用 `POST /api/plugins/reload` 即可生效（无需重启）
- `GET /api/plugins` 查看插件加载状态与工具数
- 插件动作工具的审批/审计由主服务统一把关

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
| `SECOPS_MODEL_CONFIG_PATH` | `runtime/config/model.json` | 模型配置文件路径 |
| `SECOPS_TOOL_VISIBILITY_PATH` | `runtime/config/toolVisibility.json` | 工具暴露级别用户覆盖文件 |
| `SECOPS_PLUGINS_DIR` | `runtime/plugins` | 插件目录 |
| `SECOPS_ACTION_LEVEL` | `sandbox` | 默认自动化级别（observe/sandbox/full-access） |
| `SECOPS_RUNTIME_CONFIG_PATH` | `runtime/config/settings.json` | 运行时设置文件 |
| `SECOPS_SANDBOX_ROOT` | `runtime/sandbox` | 沙箱目录 |
| `SECOPS_AUDIT_LOG_PATH` | `runtime/audit/events.jsonl` | 审计日志 |
| `SECOPS_APPROVAL_STORE_PATH` | `runtime/approvals/pending.json` | 审批存储 |
| `SECOPS_DATA_DIR` / `SECOPS_DURABLE_SESSIONS` | `runtime/pgdata` / `on` | 会话持久化（`memory://` 内存 / `off` 禁用） |
| `SECOPS_ALLOWED_HOSTS` / `SECOPS_ALLOWED_ORIGINS` | localhost,127.0.0.1,::1 / http://localhost:5317,… | Host/Origin 访问控制 |
| `SECOPS_API_TOKEN` | 空 | API Bearer 令牌（设置后所有 API 需携带） |
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
