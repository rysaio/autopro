# 前端浅色视觉体系研究：受 Apple 启发的安全运营工作台

日期：2026-08-14

状态：视觉改造的实施依据

## 1. 结论

本项目应借鉴 Apple 对“清晰层级、克制用色、动态语义色和可访问性”的处理方式，而不是复刻 macOS 控件或大面积 Liquid Glass。Windows/浏览器上的安全运营工作台仍应保持信息密度、稳定边界和熟悉的表单行为；Apple 气质主要来自精细灰阶、留白、排版、轻量层次和有限强调色。

Apple 将颜色视为沟通、状态和反馈工具，并要求同一颜色保持一致含义；Fluent 2 也以黑、白、灰作为界面基础，只让共享色和语义色强调重要区域。因此，本项目的默认交互继续使用黑白灰，蓝色不承担全局主交互，只保留给当前已经明确的 Tool 选择控件。[Apple HIG: Color](https://developer.apple.com/design/human-interface-guidelines/color) [Fluent 2: Color](https://fluent2.microsoft.design/color)

颜色不能单独表达启用、风险、错误、选中或焦点。状态必须同时有文字、图标、形状、边框或字重变化；普通文本至少达到 `4.5:1`，大文本至少 `3:1`，识别控件、图标和焦点状态所必需的视觉信息至少 `3:1`。[WCAG 2.2: Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) [WCAG 2.2: Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) [WCAG 2.2: Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)

## 2. 当前代码基准

当前实现以 `src/apps/web/src/styles.css` 为真实基准，已经具备正确的大方向：

| 现有令牌 | 保留的职责 | 禁止扩展到 |
| --- | --- | --- |
| `--accent-*` | 默认按钮、导航选中、灰阶 hover/pressed、普通焦点和链接式强调 | 风险、成功、错误等业务语义 |
| `--tool-selected-*` | `.tool-filters button.active`、配置区 Tool filter、`.tool-workspace-tabs button.active` 及其计数 | 提交按钮、普通导航、文本链接、焦点环、其他工作区选中态 |
| `--state-on-*` | checkbox/toggle 开启、连接正常、成功反馈 | 一般选中态或装饰性绿色 |
| `--warn-*` | 中风险、需要关注、指导/审批提示、indeterminate | 普通 pending、hover 或装饰 |
| `--danger-*` | 高/严重风险、失败、错误、拒绝和破坏性操作 | 一般取消、关闭、普通负向文案 |

蓝色例外应以功能范围而不是视觉偏好定义：只有“选择 Tool/Tool 工作区页签”继续使用 `--tool-selected-*`。新增控件默认不得复用该蓝色；确需新增蓝色交互时，应先证明它属于同一 Tool 选择语义。

绿色目前同时承担“开启”和“成功/健康”。为避免 Apple 所警示的同色多义，实施时应增加 `state-enabled-*` 与 `status-success-*` 两组语义别名；它们现在可以映射到同一组绿色原始值，但组件只引用对应语义别名。[Apple HIG: Color](https://developer.apple.com/design/human-interface-guidelines/color)

## 3. 浅色体系

### 3.1 中性表面

以少量、稳定的明度差建立层级，不靠彩色大背景或密集阴影：

| 层级 | 建议用途 | 当前令牌映射 |
| --- | --- | --- |
| 画布 | 应用外围、工作区底层 | `--bg-app`，可使用 `--gray-100` 一类的极浅灰 |
| 主表面 | 对话、表格、详情正文 | `--surface`，保持白色 |
| 次级表面 | 侧栏分组、只读区、代码区 | `--surface-sunken` / `--gray-50` |
| 悬停 | 可点击行和次级按钮 hover | `--accent-50` |
| 选中 | 非 Tool 的导航、分段控件、列表选择 | `--accent-100`，同时加字重、图标或边标 |
| 按下 | 短暂 pressed 反馈 | `--accent-200` |

Fluent 2 明确把黑、白、灰用于表面、文字和布局，并建议用较浅的中性色表面突出主要关注区域。Apple Materials 则强调材质的职责是分隔前景功能层与背景内容层；更不透明的材质更利于细小文字和复杂内容的可读性。[Fluent 2: Color](https://fluent2.microsoft.design/color) [Apple HIG: Materials](https://developer.apple.com/design/human-interface-guidelines/materials)

工作台的表格、审计、审批、配置和详情区优先使用实色表面。阴影只用于真正浮起的菜单、popover 和 modal；半透明/模糊只可少量用于浮层，并且不能降低文字和控件边界对比度。不要把每个区块都做成浮卡，也不要在卡片中继续套卡片。

### 3.2 文字与边界

继续使用当前跨平台 system font stack，不在 Windows 上模拟 Apple 专属字体。文字层级限制为三档主用角色：

- 主文字：`--text-strong`，标题、关键值、主要正文。
- 次文字：`--text-body`，说明、表格内容、辅助正文。
- 弱文字：`--text-muted`，元数据、时间、次级标签。
- `--text-faint` 只能用于禁用、占位或装饰，不能承载普通正文和必要状态。

`--border` / `--border-subtle` 可继续作为被动分隔线，但不能成为输入框、未选中 checkbox、焦点或选中状态的唯一识别线。需要靠边界识别的控件应增加 `--border-control`，映射到至少能与相邻表面达到 `3:1` 的灰阶。

### 3.3 交互状态

| 状态 | 视觉方式 |
| --- | --- |
| 默认主命令 | 深石墨背景、白字；不使用主蓝 |
| 次级命令 | 白/浅灰背景、深灰字、必要时使用可感知边框 |
| hover | 背景提高一个灰阶，不改变布局尺寸 |
| pressed | 再提高一个灰阶，可保留当前轻微位移反馈 |
| selected | 灰底 + 字重/图标/边标；仅 Tool 选择使用蓝色例外 |
| focus-visible | 独立的深灰 `2px` 或 `3px` 外环和 offset，不依赖 hover/selected |
| disabled | 降低强调并保留可辨识标签；禁用状态不承担操作提示 |
| destructive | 红色文字/淡红背景并带明确动作词，不把所有取消操作染红 |

Fluent 2 建议用中性色深浅变化表达 rest、hover、selected，并用更粗的外轮廓区分键盘焦点；Apple 则建议只给真正需要强调的状态和主操作使用颜色，避免多个控件同时铺设彩色背景。[Fluent 2: Color](https://fluent2.microsoft.design/color) [Apple HIG: Color](https://developer.apple.com/design/human-interface-guidelines/color)

## 4. 功能语义色

语义色只用于小面积标签、图标、边标、淡色提示面和关键数字，不用于装饰。Fluent 2 要求语义色始终传达重要信息，并与其他指示符配合；Apple 与 WCAG 同样要求不能只靠颜色区分状态。[Fluent 2: Color](https://fluent2.microsoft.design/color) [Apple HIG: Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility) [WCAG 2.2: Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)

| 语义 | 颜色 | 必须同时提供 |
| --- | --- | --- |
| Enabled / Success / Connected | `--state-on-*` 绿色，经语义别名区分 | 开关位置、check 图标、`已启用`/`已连接`/`成功`文字 |
| Warning / Needs attention | `--warn-*` 黄褐色 | warning 图标、风险级别或处理提示 |
| Error / High risk / Destructive | `--danger-*` 红色 | error 图标、错误文字、明确动作名称 |
| Tool selected | `--tool-selected-*` 蓝色 | active 样式、计数/图标、`aria-selected` 或等价状态 |
| Neutral information / Pending | 灰阶 | 状态文字和必要图标；不要新增“信息蓝” |

同一条风险信息在列表、徽章、图表、详情和审批区必须使用同一语义别名。低风险不应因为“绿色看起来安全”就自动使用 enabled/success 令牌；若业务确实需要绿色低风险，增加独立的 `risk-low-*` 别名，即使它暂时映射到相同原始颜色。

## 5. 对比度审计

以下比值按 WCAG 相对亮度公式对当前浅色令牌计算，作为实施基线：

| 当前组合 | 对比度 | 结论 |
| --- | ---: | --- |
| `--text-strong #171717` / 白 | `17.93:1` | 通过 |
| `--text-body #404040` / 白 | `10.37:1` | 通过 |
| `--text-muted #737373` / 白 | `4.74:1` | 普通文字通过，但余量有限 |
| `--text-faint #a3a3a3` / 白 | `2.52:1` | 不得用于普通文字 |
| `--border #e5e5e5` / 白 | `1.26:1` | 仅可作被动分隔 |
| `--accent-700 #262626` / `--accent-50 #f5f5f5` | `13.88:1` | 通过 |
| `--tool-selected-900 #1e3a8a` / `--tool-selected-100 #dbeafe` | `8.49:1` | 通过，继续限于 Tool 选择 |
| `--state-on-700 #027a48` / `--state-on-50 #ecfdf3` | `5.13:1` | 通过 |
| `--warn-700 #b45309` / `--warn-50 #fffbeb` | `4.84:1` | 通过，但小字避免更浅字重 |
| `--danger-700 #b91c1c` / `--danger-50 #fef2f2` | `5.91:1` | 通过 |
| 当前 `rgba(64,64,64,.24)` 焦点环叠白底 | 约 `1.52:1` | 不足，优先修正 |

第一优先级是把 `--focus-ring-color` 改为不透明或高对比的中性灰，使焦点指示与相邻表面达到至少 `3:1`。第二优先级是审计所有依赖 `--border` 识别的输入框、自定义开关和分隔拖拽手柄；被动分隔线不要求都加深，但交互边界不能只用 `1.26:1` 的灰线。[WCAG 2.2: Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)

WCAG 的比值是阈值而不是可四舍五入目标，`4.499:1` 仍不合格。正常正文建议留出余量，避免字体抗锯齿、显示器和环境光使“刚好通过”的颜色实际难读。[WCAG 2.2: Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)

## 6. 为深色模式预留接口

当前仍保持 `color-scheme: light`，本轮不应为了“预留”而提前启用未验证的深色原生控件。现在需要完成的是角色令牌隔离：组件引用 `surface-*`、`text-*`、`border-*`、`interaction-*`、`status-*`，不直接引用 hex，也尽量不直接引用原始 `gray-*` 色阶。

后续可在同名角色下增加 `[data-theme="dark"]` 或系统偏好映射。深色值必须逐角色设计，不能把浅色简单反相；背景、浮层、文字、图标和每组语义色都需重新验证。Apple 明确指出深色颜色不一定是浅色反相，Fluent 2 也会在深色模式调整共享色的饱和度和明度。[Apple HIG: Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode) [Fluent 2: Color](https://fluent2.microsoft.design/color)

建议逐步补齐以下语义别名，现阶段仍可映射到已有值：

```css
--surface-canvas;
--surface-primary;
--surface-subtle;
--surface-hover;
--surface-selected;
--text-primary;
--text-secondary;
--text-tertiary;
--border-passive;
--border-control;
--focus-ring;
--interaction-primary;
--state-enabled;
--status-success;
--status-warning;
--status-danger;
--selection-tool;
```

Fluent 2 的全局色板 + 语义 alias token 做法适合本项目：原始色值负责色阶，alias 负责上下文，组件只依赖 alias。这样未来深色、高对比或品牌调整只替换映射，不重写功能样式。[Fluent 2: Color tokens](https://fluent2.microsoft.design/color#color-tokens)

## 7. 实施与验收顺序

1. 固化蓝色白名单，只保留 Tool filter 和 Tool workspace tab 的 selected 状态。
2. 修正焦点环与交互边界对比度；检查键盘焦点不被 hover/selected 覆盖。
3. 统一画布、主表面、次级表面、hover、selected、pressed 六个中性层级。
4. 为 enabled、success、warning、danger、Tool selected 增加语义别名，收敛散落的 hex/rgba。
5. 检查每个状态是否同时有文字、图标、形状或字重，不以颜色为唯一线索。
6. 在 `1440px`、`1080px`、`900px`、`640px` 视口检查层级、文本溢出和控件尺寸；在 Windows Edge/Chrome 至少覆盖默认、hover、pressed、selected、focus-visible、disabled、error。
7. 深色模式开始前，为每个角色建立独立 dark 映射，并重新跑全文字、图标、边框、焦点和语义色对比度审计。

## 8. 一手来源

- [Apple Human Interface Guidelines: Color](https://developer.apple.com/design/human-interface-guidelines/color)
- [Apple Human Interface Guidelines: Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
- [Apple Human Interface Guidelines: Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
- [Apple Human Interface Guidelines: Dark Mode](https://developer.apple.com/design/human-interface-guidelines/dark-mode)
- [W3C WCAG 2.2 Understanding 1.4.1: Use of Color](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html)
- [W3C WCAG 2.2 Understanding 1.4.3: Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
- [W3C WCAG 2.2 Understanding 1.4.11: Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)
- [Microsoft Fluent 2: Color](https://fluent2.microsoft.design/color)
