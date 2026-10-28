<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/brand/mikka-icon-dark.svg">
  <img src="public/brand/mikka-icon-light.svg" alt="Mikka" width="112">
</picture>

# Mikka

### 为大事而生的 AI lead。

从本地到云端，所有 Agent 协作如一。

[![CI](https://github.com/alexj11324/Mikka/actions/workflows/ui-policy.yml/badge.svg?branch=main)](https://github.com/alexj11324/Mikka/actions/workflows/ui-policy.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![LINUX DO](https://img.shields.io/badge/LINUX%20DO-Community-FFB003)](https://linux.do)

[访问 Mikka](https://app.aspectlylabs.com/mikka) · [文档](https://aspectlylabs.com/mikka/docs) · [快速入门](https://aspectlylabs.com/mikka/docs/quickstart)

[English](README.md) · **简体中文**

</div>

Mikka 将你现有的 coding agent 组织为一个协同工作的团队。你只需用自然语言向 bot 描述需求，它会将需求拆解为任务，并分派给 Claude Code、Codex 或 Cursor 执行。编码任务可在你自己的设备上运行。Bot 也可以拥有云端桌面；托管编码任务仍待真实服务商验收。

你可以实时跟进每项工作的进展，在需要决策时介入，并在完成后审阅结果。

## 工作方式

- **Bot 负责协调，线程负责执行。**
  - Bot 与你对话，制定计划并分派任务，本身不直接执行工作。
  - 左侧栏是你的 bot 列表，Coordinator 是其中之一。你可以用名称、颜色和形状新建 bot；每个 bot 都有独立的对话、记忆、收件箱和租约。
  - 每项工作在独立的**线程**中运行。线程对应一次工作运行，拥有独立的名称，通常关联一个任务。一个 bot 可以同时管理多个线程。
  - 完整定义参见 [术语表](docs/design/glossary.md)。
  - **Harness 是执行层，不是另一个 Bot。** Bot 通过 Mikka 的 AI SDK / Workflow harness 处理对话和工具；派发的编码线程由 daemon 选择 Claude Code、Codex 或 Cursor CLI harness 执行。旧的独立 Agent 聊天已退役，历史记录仅供查看。

- **所有 bot 共用同一套 harness。**
  - Coordinator 是常驻运行的 bot。当运行结束、任务状态变更或 worker 提出问题时，它会被唤醒并决定下一步操作，仅在需要你决策时发出通知。
  - 它的协调 harness 与执行编码线程的 CLI harness 分开运行；你创建的每个 bot 都在同一套 harness 上对话。

- **先确认，再执行。**
  - Coordinator 可以在对话中确认缺少的信息；按需求歧义程度系统分流仍在开发中。
  - 运行过程中，agent 可以提出问题或报告阻塞。将人工回答持久化并送回等待中的运行仍待验证。

- **运行在你的设备或云端电脑上。**
  - Mikka daemon 可连接你的 Mac、Linux 主机或服务器。
  - Bot 也可以拥有一台云端电脑：独立桌面，可实时查看、随时接管并交还；空闲时自动休眠并保留磁盘数据。
  - 在你自己的设备上，Daemon 通过你已安装并登录的 CLI harness 执行线程，因此沿用你现有的订阅与配置。

- **故障后自动恢复。**
  - 运行使用租约和 checkpoint。交接到拥有同一仓库的在线设备已有实现与测试，真实双机交接仍待验证。

- **融入现有工具。**
  - 任务与 Linear 双向同步；其他 agent 可通过 MCP 操作 Mikka；你也可以在 Telegram 或 Slack 中直接提出需求。

### 任务流转

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/task-flow-zh-dark.svg">
  <img src="docs/assets/task-flow-zh-light.svg" alt="任务在 Mikka 中的流转：请求经过分诊并派发；需求澄清路由、回答送回等待中的运行和 Factory 阶段仍待完成或验收。">
</picture>

实线表示已接入的路径；虚线包含规划中和仍待端到端验收的路径。人工回答送回等待中的运行仍待验证。Factory 虚线流程包括：独立的审查与验证（[#193](https://github.com/alexj11324/Mikka/issues/193)）、检查未通过时派发修复运行、按适用策略决定发布（[#194](https://github.com/alexj11324/Mikka/issues/194)），以及将故障转为 issue 的监控（[#195](https://github.com/alexj11324/Mikka/issues/195)）。按需求歧义程度进行系统分流在 [#192](https://github.com/alexj11324/Mikka/issues/192) 中跟踪。

## 当前功能

- **将需求转化为任务。** Coordinator 将请求拆解为任务并派发运行，同时判断每个任务归属于工作区还是个人。如判断有误，可一键修改。
- **可创建多个 bot。** 每个 bot 拥有独立的对话、记忆、收件箱和租约，并与 Coordinator 共用同一套 harness。
- **在云端工作。** Bot 可以拥有独立桌面，支持实时查看、随时接管并交还；空闲时自动休眠并保留磁盘数据。
- **完整呈现执行过程。** 每个线程都会展示其 agent 当前的操作。Worker 可通过 Mikka 的 MCP 工具汇报进度、提出问题或报告阻塞；持久化回答路由仍待验证。
- **注明信息来源。** 回复中引用的任务、运行记录和网页以可点击的标签形式展示。
- **统一管理任务。** 任务支持看板和列表两种视图，包含关联关系、活动记录和个人任务编号，并与 Linear 双向同步。
- **用 ⌘K 快速查找。** 可从键盘搜索 bot、对话、任务和项目。
- **筛选重要通知。** Mikka 汇总来自 GitHub、Linear、Notion、Slack 和 Gmail 的通知，仅保留需要你关注的内容，并生成每日简报。
- **在已连接应用中操作。** Coordinator 可以提出邮件和 Google 日历操作。审批执行路径已有实现，真实外部写入和按策略 allow / ask / deny 执行仍待端到端验收。
- **支持从其他工具调用。** 可在 Claude Code 或 Codex 中通过 [MCP server](https://aspectlylabs.com/mikka/docs/mcp) 操作 Mikka。
- **支持团队协作。** 提供工作区、成员、邀请和团队管理，支持 Google 和 GitHub 登录。
- **双语界面。** 应用提供英文和简体中文界面。

## 开发路线

目标授权流程由具备视觉能力的模型判断业务语义与行动。已有 auto-review 或 MCP 策略为 allow 时直接执行，ask 时请求确认，deny 时停止；鉴权、凭据保护、幂等和机械检查继续生效。敏感删除、安全设置等仍遵守适用策略的确认要求。此流程仍需实现和验收。

正在进行的工作在 [GitHub issues](https://github.com/alexj11324/Mikka/issues) 中跟踪，并与 Linear（`MIK-xx`）同步。

| 方向 | 规划内容 | 跟踪 |
| --- | --- | --- |
| **iOS App** | 在 iPhone 上使用 Coordinator 对话、线程、任务和设置。App 已接入服务端，TestFlight 验收尚未完成。 | [PR #340](https://github.com/alexj11324/Mikka/pull/340) |
| **群聊** | 支持多个 bot 与多名成员在同一对话中协作，提供轮流发言、@ 提及以及「正在工作」状态栏。 | [#105](https://github.com/alexj11324/Mikka/issues/105) |
| **Factory** | 完整的交付流程：同一任务同一时间仅执行一次、阶段状态持久化、独立的审查与验证线程，以及基于实际证据和适用策略的发布决策。 | [#191](https://github.com/alexj11324/Mikka/issues/191)–[#195](https://github.com/alexj11324/Mikka/issues/195) |
| **定时任务** | Bot 可在指定时间或按周期执行任务，并将结果返回至对话。 | [#179](https://github.com/alexj11324/Mikka/issues/179) |
| **Connected apps** | 文档与 Slack 操作，以及邮件和日历之外的更多工作流，按策略执行 allow / ask / deny。 | [#177](https://github.com/alexj11324/Mikka/issues/177) |
| **安全凭据** | Agent 通过安全表单请求凭据。凭据由保管库存放，受控浏览器仅在获批操作中使用。 | [#180](https://github.com/alexj11324/Mikka/issues/180) |
| **体验优化** | 新用户引导、跨页面与内容的全站搜索、知识库、agent 网页搜索，以及团队可见范围设置。 | [#129](https://github.com/alexj11324/Mikka/issues/129)、[#131](https://github.com/alexj11324/Mikka/issues/131)、[#134](https://github.com/alexj11324/Mikka/issues/134)、[#100](https://github.com/alexj11324/Mikka/issues/100)、[#127](https://github.com/alexj11324/Mikka/issues/127) |

## 接入 agent

### 通过 MCP 操作 Mikka

Mikka 提供 MCP server（Streamable HTTP，OAuth 2.1）。在 Claude Code 中添加：

```sh
claude mcp add --transport http mikka https://app.aspectlylabs.com/mikka/api/mcp
```

Claude Code 会打开浏览器完成登录。登录后，agent 可以读取和修改任务、派发运行，以及更新 Coordinator 的记忆。其他客户端的接入方式和完整工具列表参见 [MCP 文档](https://aspectlylabs.com/mikka/docs/mcp)。

### 在自有设备上运行编码 harness

[`packages/daemon`](packages/daemon) 中的 daemon 会检测设备上已安装的编码 CLI harness，并通过选定的适配器执行工作线程：

| 执行 harness | 检测的 CLI |
| --- | --- |
| Claude Code | `claude` |
| Codex | `codex` |
| Cursor | `cursor-agent` 或 `agent` |

每次运行使用独立的 git worktree，并行线程之间相互隔离。

## 架构

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture-zh-dark.svg">
  <img src="docs/assets/architecture-zh-light.svg" alt="Mikka 架构：Web 应用、Telegram、Slack 和 MCP 客户端接入 Vercel 上的 Next.js 应用；Coordinator 将运行派发给设备上的 daemon，也可唤醒 bot 的云端电脑；托管编码运行与获批邮件和日历写入仍待验收；agent 通过 MCP 回报；状态存储在 Postgres 并与 Linear 同步。">
</picture>

Web 应用、Telegram、Slack 和 MCP 客户端均接入部署在 Vercel 上的同一个 Next.js 应用。运行结束、worker 提问等事件会发送给 Coordinator。Coordinator 是一个持久化 workflow，负责对每个事件进行分诊并决定下一步操作。

在你自己的设备上，Daemon 注册设备后通过设备 API 领取运行，并在独立的 git worktree 中启动对应的 agent CLI。Coordinator 可以唤醒 bot 的 E2B 桌面，用户可以查看、接管并交还。托管 worker 已有实现，但真实订阅支持的编码任务尚未验证。基于 checkpoint 的交接已有测试，真实双机交接仍待验证。

Coordinator 可以提出邮件和日历操作并等待批准；真实外部写入与按策略执行 allow / ask / deny 仍待端到端验收。

Linear 同步运行在 Cloudflare Worker 上，通过持久化的 inbox 和 outbox 与 Postgres 交换变更。

虚线框和虚线表示规划中或仍待端到端验收的部分，包括托管编码、回答路由和获批邮件/日历写入。其他路线图项目：Scheduler（[#179](https://github.com/alexj11324/Mikka/issues/179)）、Factory 阶段（[#191](https://github.com/alexj11324/Mikka/issues/191)–[#194](https://github.com/alexj11324/Mikka/issues/194)）、监控（[#195](https://github.com/alexj11324/Mikka/issues/195)）、本机 computer use（[#147](https://github.com/alexj11324/Mikka/issues/147)）、邮件和日历之外的 Connected apps 工作流（[#177](https://github.com/alexj11324/Mikka/issues/177)）以及凭据保管库（[#180](https://github.com/alexj11324/Mikka/issues/180)）。

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 应用 | Next.js 16、React 19、Tailwind CSS 4、shadcn/ui、ReUI |
| Bot | Vercel AI SDK；Coordinator 是运行在 [Vercel Workflow](workflows/coordinator) 上的持久化循环 |
| 分诊 | 目标是由具备能力的模型判断业务语义，按策略执行 allow / ask / deny，并保留机械安全检查；现有规则优先路由仍待调整和验收 |
| 数据 | Neon 托管的 Postgres，Drizzle 迁移位于 [`drizzle/`](drizzle) |
| 认证 | Better Auth，支持 Google 和 GitHub 登录，并为 MCP 提供 OAuth 2.1 server |
| 集成 | GitHub 与 Linear 使用 webhook；Gmail、Google 日历、Notion、Slack 通过 Composio 接入，邮件和日历审批写入仍待外部验收；Linear 同步与定时简报运行在 Cloudflare Worker 上；Telegram 与 Slack 基于 Vercel Chat SDK |
| 执行 harness | Mikka daemon，内置 Claude Code、Codex 和 Cursor 适配器；bot 专属 E2B 桌面的托管 worker 仍待真实服务商验收 |

## 目录结构

```text
agents/              # 内置 Bot 定义与 Skill
app/                 # Next.js 路由、server actions 与 API（MCP、webhook、daemon /v1）
apps/mobile/         # Expo iOS App
components/          # React 界面组件
lib/                 # 业务逻辑：Coordinator、任务、Linear 同步、MCP、认证、云端电脑
workflows/           # 持久化 workflow（Coordinator 与 Slack）
packages/daemon/     # 本地 daemon 和 CLI 执行 harness 适配器
packages/protocol/   # 服务端与 daemon 共用的类型定义
packages/config/     # 共享配置
packages/subscription-worker/  # 订阅接入与托管运行 worker
cloudflare/          # 用于 Linear 同步与定时简报的 Cloudflare Worker
drizzle/             # 数据库迁移
messages/, i18n/     # 英文与简体中文文案
tests/               # 单元测试、验收测试与 Playwright 测试
docs/                # 工程与设计文档
```

## 开发

Mikka 基于云端 Preview 部署进行开发，不在本地运行服务。构建、类型检查和端到端测试均在 CI 中执行，每个 pull request 都会生成独立的 Preview URL。凭据统一存放在 Infisical Cloud，不得提交至仓库或写入本地 `.env` 文件。

安装依赖并运行无需服务端的检查：

```sh
pnpm install
pnpm check
```

`pnpm check:ci` 为完整的 CI 检查，在 `check` 的基础上还包括生产构建、性能测试和 Playwright 测试。

建议首先阅读以下文档：

- [`AGENTS.md`](AGENTS.md)：所有贡献者和 coding agent 须遵守的规则。
- [`docs/design/README.md`](docs/design/README.md)：进行任何设计、spec 或 UI 工作前必读。
- [`docs/design/glossary.md`](docs/design/glossary.md)：bot、线程与对话的定义。
- [`docs/acceptance.md`](docs/acceptance.md)：变更在 Preview 上的验收流程。
- [`docs/review-checklist.md`](docs/review-checklist.md)：向他人展示 UI 前须完成的检查项。

## 获取访问权限

Mikka 目前处于早期体验阶段。请发送邮件至 [mikka@aspectlylabs.com](mailto:mikka@aspectlylabs.com) 申请邀请，然后参照 [快速入门](https://aspectlylabs.com/mikka/docs/quickstart) 开始使用。

## 许可证

Mikka 采用 [AGPL-3.0-only](LICENSE) 协议开源。第三方组件遵循各自的许可证，详见 [`packages/daemon/THIRD_PARTY_NOTICES.md`](packages/daemon/THIRD_PARTY_NOTICES.md)。

如果你将修改后的 Mikka 作为网络服务提供给他人使用，AGPL 要求你向这些用户提供所部署版本的源代码。

## 参与贡献

欢迎参与贡献，请先阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md)。贡献的代码按照项目的 [AGPL-3.0-only](LICENSE) 协议授权，无需另行签署贡献者协议；贡献者保留其作品的版权。
