# Issue #11：真实模型回归基准与 README 校正

日期：2026-08-12　状态：已实施，待人工复核　关联：Issue #11 / PRD #1

## 执行环境

- 源码开发构建（`npm run build`），本地 Fastify 服务，真实 DeepSeek 连接
- Provider / Model：`deepseek` / `deepseek-v4-flash`（`https://api.deepseek.com`）
- 每场景采样：3 次（`plugin-reload` 为 1 次）
- 凭据：仅由 `runtime/config/model.json` 读取；基准脚本与对比脚本永不打印或持久化 API key / 授权头
- 无固定延迟或人工模型结果，全部为真实模型请求

## 运行方式

分别以三种路由模式启动源码服务（`SECOPS_AGENT_ROUTING_MODE=single|layered|deterministic`），再执行：

```powershell
cd src
npm run benchmark:agent -- --mode single --scenario all --runs 3 --json > benchmark-single.json
npm run benchmark:agent -- --mode layered --scenario all --runs 3 --json > benchmark-layered.json
npm run benchmark:agent -- --mode deterministic --scenario all --runs 3 --json > benchmark-deterministic.json
npm run benchmark:compare -- benchmark-single.json benchmark-layered.json benchmark-deterministic.json
```

## 结果摘要（中位数，单位 ms）

### 简单无工具请求

| 模式 | 首文本 | 总耗时 | 模型请求数 | 真实 handler 数 |
| --- | ---: | ---: | ---: | ---: |
| single（旧单阶段基线） | 1027.08 | 1067.39 | 1 | 0 |
| layered（旧双阶段回滚） | 2264.24 | 2280.94 | 2 | 0 |
| deterministic（新默认） | 823.15 | 914.76 | 1 | 0 |

### 一次只读工具调用（threat.intel.lookup）

| 模式 | 首文本 | 总耗时 | 模型请求数 | 缓存命中/未命中 |
| --- | ---: | ---: | ---: | ---: |
| single | 2242.85 | 4479.57 | 2 | 2 / 1 |
| layered | 7271.99 | 6912.36 | 3 | 2 / 1 |
| deterministic | 1754.83 | 4262.76 | 2 | 2 / 1 |

首样本真实执行 handler（1 次 miss），随后同 TTL 内命中；第 2、3 样本 handler 为 0。

### TTL 内重复只读调用（热缓存）

| 模式 | 首文本 | 总耗时 | 模型请求数 | 缓存命中/未命中 |
| --- | ---: | ---: | ---: | ---: |
| single | 2220.55 | 4672.34 | 2 | 3 / 0 |
| layered | 5794.56 | 7291.46 | 3 | 3 / 0 |
| deterministic | 1833.39 | 4901.36 | 2 | 3 / 0 |

### 长对话（12 轮历史 + 最终请求）

| 模式 | 首文本 | 总耗时 | 模型请求数 |
| --- | ---: | ---: | ---: |
| single | 1472.86 | 1592.34 | 1 |
| layered | 2408.10 | 2641.73 | 2 |
| deterministic | 1139.70 | 1325.58 | 1 |

所有运行 `contextBudget.withinBudget=true`，无折叠/丢弃（历史长度未触发预算压缩）。

### 通用插件 reload 后路由（shuffle.config.status）

| 模式 | 首文本 | 总耗时 | 模型请求数 | 真实 handler 数 | 路由命中 |
| --- | ---: | ---: | ---: | ---: | ---: |
| single | 2771.68 | 5490.71 | 2 | 1 | 是 |
| layered | 7419.48 | 10857.81 | 3 | 1 | 是 |
| deterministic | 2417.32 | 5038.94 | 2 | 1 | 是 |

## 发布门禁

| 检查项 | 结果 |
| --- | --- |
| 简单无工具请求在 deterministic 下仅 1 次模型调用 | 通过（1） |
| deterministic 中位首文本 ≤ single 基线 1.2x | 通过（0.80x） |
| deterministic 中位总耗时 ≤ single 基线 1.25x | 通过（0.86x） |
| 无固定延迟/人工模型结果 | 通过（全部真实 deepseek-v4-flash） |
| README 不声明固定工具数量或未经验证的 token 节省 | 通过（见 README 修订） |

## 待人工复核

- 本报告与 README 中所有性能数字需人工复核并批准。
- 批准后关闭 Issue #11；随后可评估关闭父 PRD Issue #1。

## 原始数据

- [benchmark-single.json](benchmark/benchmark-single.json)
- [benchmark-layered.json](benchmark/benchmark-layered.json)
- [benchmark-deterministic.json](benchmark/benchmark-deterministic.json)
- [benchmark-comparison.json](benchmark/benchmark-comparison.json)
