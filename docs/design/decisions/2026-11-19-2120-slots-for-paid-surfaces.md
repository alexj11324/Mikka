# 为 Automations、PR 目录、Environments、自动化编辑器新增付费实现的 slot

2026-11-19。Alex：「去用我们的付费组件库去实现吧，前后端一起实现。」

## 背景

AGENTS.md 规定「不要为了修复而加 slot 或搬代码」，付费组件（BoardUI Pro、affectUI、beUI Pro）只用在已经用了的地方。Automations 列表、自动化编辑器、PR 目录、Environments 设置目前只在公开仓库，用的是 shadcn。

## 决定

- 这几个界面按 Alex 本次的明确指示改用付费组件库实现：新增 `@ui-slot/automations`、`@ui-slot/automation-editor`、`@ui-slot/pull-directory`（Environments 设置同理，按需），契约放 `components/slots/*-contract.ts`，付费实现放私有仓库 `mikka-hosted-ui/slots/`，公开仓库保留可编译的默认版。
- 这是对上面那条规则的**有意例外**，理由是整页对齐 Capy 的重做，而不是为一处修复开口子。其他页面仍按原规则。
- 付费源码只进私有仓库；已经在 slot 里的页面（看板、任务详情、新建任务、Bot 相关：affectUI；PR 审阅：BoardUI Pro）继续用原来的库。
