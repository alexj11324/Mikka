# 按任务难度自动选模型

- **Status:** accepted scope from issue #1329; implementation review 2026-11-05
- **GitHub:** [#1329](https://github.com/alexj11324/Mikka/issues/1329)
- **Owner thread:** issue #1329 implementation
- **Changed:** 2026-11-06, [judge model strength and effort only](decisions/2026-11-06-1640-model-routing-judges-tier-and-effort.md)

## What the user does

用户在「模型与订阅」决定派发给 Agent 的任务是否按难度自动选择模型，并在执行详情查看这一次实际冻结的所需模型强度、模型、推理强度和选择原因。

## Where it lives

「模型与订阅」的「优先使用的模型」区域，在「优先使用的 Agent」下方增加开关。线程现有「执行身份与费用归属」弹窗在运行基本信息之后显示「模型选择」，继续使用当前执行 ID 的 owner evidence 接口。

## Layout and states

开关默认开启，按当前用户和工作区保存；点击立即保存，保存期间禁用控件。失败恢复上次保存值，并使用现有错误行和「重试」；离线重读失败也不能保留未保存的开关状态。

未自定义列表且开启时，保留原默认列表的前缀顺序，只追加默认列表已经选中的凭据所上报的其余已授权模型，并按现有 Agent 偏好去重。不为了新增轻量模型自动加入另一枚原本不在默认列表中的付费 API Key。关闭后回到原默认列表；已自定义列表严格保留用户选择。页面和派发读取同一列表。

执行详情只显示本次执行冻结的 `modelDispatch.routing`，不从当前设置补齐。缺少快照的旧记录不显示「模型选择」；无推理强度覆盖时不虚构数值。记录升级时显示升级前的模型。弹窗保留现有加载、失败和重试状态；窄屏换行并在视口内滚动，明暗模式均使用现有语义颜色。

## Rules that apply

沿用 R-40（无说明性口水话）、R-62（线程及其权限边界）、R-90（复用组件），以及现有执行身份快照与设置自动保存约定。本次按 issue #1329 已批准范围实现，不引入新的导航、权限或视觉规则。

## Components

- 设置：现有 `SettingsSection`、`SettingRow`、`Switch`、`SettingsSaveError`。
- 执行详情：现有 `ThreadExecutionIdentity` 弹窗、`ValueRow`、`ModelLabel`。
- 数据：现有 `model-order` 设置读写与推送；现有 owner evidence 接口和按实际执行 ID 的读取缓存。

## Copy

| 中文 | English |
| --- | --- |
| 按任务难度自动选模型 | Choose models automatically by task difficulty |
| 派发给 Agent 的任务从这里选模型 | Tasks dispatched to an Agent choose from these models |
| 模型选择 | Model selection |
| 选择原因 | Selection reason |
| 升级前的模型 | Model before escalation |
| 轻量模型 / 标准模型 / 最强模型 | Light model / Standard model / Strongest model |
| 简单 / 中等 / 困难（2026-11-06 之前冻结的记录） | Easy / Medium / Hard (records frozen before 2026-11-06) |
| 低推理强度 / 中等推理强度 / 高推理强度 / 极高推理强度 / 最高推理强度 | Low / Medium / High / Extra-high / Maximum reasoning effort |
| 按任务所需的模型强度选择 | Selected by the model strength the task needs |
| 按模型列表顺序选择 | Selected in model list order |
| 模型强度判断不确定，沿用模型列表顺序 | Model strength was uncertain; used model list order |
| 模型强度判断暂不可用，沿用模型列表顺序 | Model strength assessment was unavailable; used model list order |
| 模型强度判断无效，沿用模型列表顺序 | Model strength assessment was invalid; used model list order |
| 没有选出合适模型，沿用模型列表顺序 | No suitable model was selected; used model list order |
| 原模型未能完成任务，已升级重试 | The previous model could not finish the task; retried with a stronger model |

判断结果行格式：`轻量模型 → GPT-6 Luna · 低推理强度` / `Light model → GPT-6 Luna · Low reasoning effort`。模型沿用现有显示名称；没有冻结的推理强度时省略分隔点和强度；没有判断出模型强度（沿用列表顺序）时省略强度和箭头，只显示模型，原因行说明为什么。

## Out of scope

不改变用户显式模型选择、Bot 对话模型、凭据授权或计费归属。不新增轮询、独立详情入口或旧记录回填。

## Done when

设置默认值和 owner/workspace 隔离、关闭后的旧顺序、自定义列表不扩展、保存失败恢复及重试均通过针对性测试。执行证据仅投影允许字段，旧记录不造数据，错误执行 ID 和跨用户读取仍被拒绝。完成 `docs/review-checklist.md` 与 1440/390 宽度的明暗生产构建截图检查。
