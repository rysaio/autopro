# SecOps Agent Console

一个 TypeScript 编写的安全运营 agent web 应用:在受控权限、审计与工具注册边界内，让模型更加自由地运用 SecOps 技能与 MCP 工具，对接现有安全运维平台，替代固定剧本编排，实现智能安全运营。

预装 Wazuh、 Shuffle 控制插件，支持更多自定义扩展，让 agent 通过 MCP 工具自由扩展安全运营能力。


## 快速启动

**方式一：直接运行已打包程序（Windows）**

```text
双击 executable/start.bat        # 启动 API + Web，自动打开浏览器
双击 executable/stop.bat         # 停止
```

**方式二：从源码开发**

```bash
cd src
npm install                      # 只需在初次使用时运行 npm install 
npm run dev                      # Web :5317 · API :4317（停止：npm run stop:dev）
```

默认地址：Web `http://localhost:5317` · API `http://localhost:4317` · 健康检查 `GET /api/health`。


## 深入了解

- 项目说明与常用命令：`src/README.md`
- 架构、权限、审批、MCP 边界：`src/docs/architecture.md`
- 计划 / 规格 / ADR：`src/docs/aegis/INDEX.md`
