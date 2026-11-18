# 图标统一用 affectUI 的 Hugeicons

2026-11-18：Alex 的原话是「Unify the icons on affectUI's icons, except the task status icons.」，中文原话是「统一 affectui 里面的 icon，除开任务的 status 的 icon 以外」。

在此之前官方界面同时有三种画法：`mikka` 用 `lucide-react`（246 个文件），`mikka-hosted-ui` 的手写页面用 `@remixicon/react`，只有 affectUI 的 `components/mikka/*` 用 Hugeicons。三套线宽和字形比例混在一起，是「看着毛糙」的一部分。

## 决定

- Mikka 自己的界面只用一套图标：affectUI 的 Hugeicons，即 `@hugeicons/core-free-icons`（图标数据）加 `@hugeicons/react`（渲染器）。Mikka 和官方 UI 用的是 `mikka-hosted-ui` 已有的版本，两个包都是公开 npm 包，公开构建不需要私有源码。
- 这一套的唯一来源是公开仓库的 `components/icons/index.tsx`：每个图标是一个组件，由 Hugeicons 的数据经一个工厂函数生成。私有层的手写文件通过 `@/components/icons` 引用同一份，靠 `mikka-hosted-ui` 已有的 `@/*` → `../*` 路径映射，不复制第二份图标表。
- **任务状态图标不动**：`TaskStatusIcon`、`TaskRunMark`、`TaskStatusMark`（[2026-11-13-1405](2026-11-13-1405-one-task-status.md)）和它们用的 `ISSUE_STATUSES` 字形继续是 lucide，`components/workspace/status-icons.tsx` 继续画 `STATUS_ICONS` 之外的三枚状态环。任何地方都不许用 Hugeicons 字形顶替状态。任务的优先级不是状态：`ISSUE_PRIORITIES` 换成新的一套（见下）。
- 付费库原样保留：BoardUI 源码（`components/base/`、`components/application/`、`components/foundations/`）继续用 `@remixicon/react`；affectUI 与 beUI Pro 源码及其使用点（[2026-11-09-0050](2026-11-09-0050-paid-blocks-as-shipped.md) 列出的路径）继续用它们自带的图标。

## 为什么是一个适配组件，而不是换 import

BoardUI 的图标 prop 收的是组件引用（`leadingIcon={RiAddLine}`），Hugeicons 收的是图标数据（`icon={Add01Icon}` 加渲染器）。调用点无法只换 import。

选择的做法是一个工厂：`glyph(iconData)` 返回一个 `forwardRef` 组件，内部渲染 `<HugeiconsIcon>`，并从 props 取 `size`、`strokeWidth`、`className` 和其余 SVG 属性。这样

- BoardUI 的 prop 契约不变，`leadingIcon={Plus}` 照写；
- 每个调用点的 class、尺寸和线宽原样生效：默认 24 盒子、`strokeWidth` 2、`currentColor`，这正是 lucide 的默认值，所以迁移不改变像素尺寸；
- 不 fork BoardUI、不给 BoardUI 加 prop。

`IconProps` 另外接受 `data-icon`，因为 R-94 要求 Button 内的图标带这个槽位。

## 字形怎么选的

不是按名字猜的。每个 lucide 字形在 Chromium 里与 Hugeicons 候选一起栅格化成 24×24 位图并比对，再逐个看形状。由此定了三件事：

- 名字相同的 Hugeicons 图标通常就是同一个符号（`Check`、`Plus`、`ChevronDown`、`Server`、`Lock`），直接用。
- 名字对不上而形状对得上的换名字：看板 = `Kanban`（Hugeicons 没有 `Columns3`），书签夹 = `Pin02`（`Pin` 是地图针），刷新 = `Reload`，撤销/重做 = `Undo`/`Redo`，用户组 = `UserMultiple03`。
- 优先级没有 1/2/3 递增条形的对应物，改用 1/2/3 根等高条（`SignalLow` → `Tally1`、`SignalMedium` → `Tally2`、`SignalHigh` → `Tally3`），`ISSUE_PRIORITIES` 原来靠 `viewBox` 裁切凑高度的那套也随之删掉。

## 执行

- 公开仓库 `scripts/ui-policy.mjs`、`scripts/interaction-policy.mjs`、`scripts/icon-button-policy.mjs` 原来只把 `lucide-react` 认作图标来源；现在认 `@/components/icons`，`lucide-react` 只留给状态图标的那几个文件。策略没有删除，只是多认了一套来源。
- 剩下的 `lucide-react` 引用只有 `components/workspace/task-state-icon.tsx`、`components/workspace/status-icons.tsx`、`components/workspace/issue-properties.ts`（状态字段）三处状态图标；`mikka-hosted-ui` 剩下的是 BoardUI 源码、affectUI/beUI 使用点、任务状态（`components/mikka/task-state.tsx`）和 `components/mikka/review-page/`（MIKK-54 正在重做，由它自己应用同一套）。
- `apps/mobile` 不在这次范围内：它用的是 `lucide-react-native`，和 Web 不是同一个渲染目标，iOS 无法在本机验收。它需要单独的决定。
