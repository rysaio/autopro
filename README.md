# SecOps Agent 优化版 v2.0

## 算法创新说明

本研究在传统安全编排自动化与响应(SOAR) Agent架构基础上，提出两项关键算法创新，显著降低大语言模型(LLM)推理成本：

### 创新一：分层工具路由 (Layered Tool Routing)

**问题**：传统Agent架构将所有工具（37个，约6000 tokens）一次性注入LLM上下文，导致：
- 大量工具schema占用上下文窗口，压缩有效信息空间
- 无关工具的schema产生"注意力稀释"效应，降低推理质量
- 每次请求都承担全部工具描述的成本

**方案**：采用"先路由后加载"的两阶段策略：

**Phase 1 (Triage)**：仅发送5个核心分诊工具（~800 tokens），快速确定分析师意图
- secops_ioc_enrich：IOC富化查询
- secops_threat_intel：威胁情报搜索
- secops_asset_lookup：资产信息查询
- secops_mitre_lookup：MITRE ATT&CK技战术检索
- secops_alert_playbook：告警剧本推荐

**Phase 2 (Deep Dive)**：根据Phase 1结果，动态加载对应领域的专用工具
- Wazuh平台工具（Agent管理、告警搜索、网络分析、Active Response）
- Shuffle SOAR工具（工作流、Webhook、告警转发）
- 报告生成工具（事件报告、证据导出）
- 沙箱操作工具（案例笔记、命令执行）

**效果**：Phase 1节省约85%的tool schema token开销，Phase 2仅加载相关工具，避免无关工具的注意力干扰。

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
请求 → Phase 1: Triage (5核心工具) → 意图推断 → Phase 2: Deep Dive (动态工具集)
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

Node.js 建议使用 24 LTS。首次运行前，将 `.env.example` 复制为 `.env` 或 `.env.local`（服务、安全、持久化等配置）。模型配置不再走 env 或配置文件——它收敛为单一明文文件 `runtime/config/model.json`（运行时热配置），支持两种用法：

- **先配置再启动**：直接编辑 `runtime/config/model.json`（结构见下方示例）
- **启动后配置**：服务启动后通过 API 增删改/切换模型连接，立即生效、无需重启：

```bash
# 查看连接
curl http://127.0.0.1:4317/api/model-config
# 新建连接（首个连接自动设为活动）
curl -X POST http://127.0.0.1:4317/api/model-config \
  -H "Content-Type: application/json" \
  -d '{"name":"qwen","provider":"qwen","model":"qwen3.6-max-preview","baseUrl":"https://dashscope.aliyuncs.com/compatible-mode/v1","apiKey":"your-key"}'
# 切换活动连接
curl -X POST http://127.0.0.1:4317/api/model-config/<id>/activate
```

`runtime/config/model.json` 示例：

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

### 2. 启动源码服务

在 `src/` 目录执行：

```powershell
npm run dev
```

该命令会同时启动：

- Vite 前端：http://localhost:5317
- Fastify 后端：http://127.0.0.1:4317

前端开发服务器会把 `/api` 请求代理到 4317 端口。也可以分别启动：

```powershell
npm run dev:server
npm run dev:web
```

如果本机已有服务占用后端端口，可以用独立的临时端口和内存会话进行源码调试：

```powershell
$env:PORT = "4327"
$env:SECOPS_DURABLE_SESSIONS = "off"
npm run dev:server
```

这种方式不会读取或修改 `src/apps/server/runtime/pgdata`。若前端也需要连接该端口，可设置 `VITE_API_BASE_URL=http://127.0.0.1:4327` 后重新启动 Vite。

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

在运行 `npm run dev` 的终端按 `Ctrl+C`。如果使用了独立后端端口，也只需停止对应的开发进程。

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
        ├── config/    # 运行时配置（model.json 模型热配置、settings.json）
        └── plugins/   # 插件目录（wazuh-secops、shuffle-secops 预置于此）
```
