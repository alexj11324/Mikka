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

Mikka 将分布在你的电脑、远程服务器与云端基础设施上的 AI agent 连接成一个协同工作的团队。向 Bot 描述需求，它会为已连接设备上的 Claude Code、Codex 和 Cursor 安排编码任务。云端桌面支持查看、接管和交还；真实订阅支持的托管编码任务仍待验收。

在网页或 macOS 桌面应用中，于同一个地方跟进进展、回应问题并审阅结果。

## 工作方式

- **Bot 负责协调，线程负责执行。**
  - Bot 与你对话，制定计划，并将编码任务派发给不同设备上的 agent。
  - 每项工作在独立的**线程**中运行。线程对应一次工作运行，拥有独立的名称，通常关联一个任务。一个 bot 可以同时管理多个线程。
  - 完整定义参见 [术语表](docs/design/glossary.md)。
  - **Harness 是执行层，不是另一个 Bot。** 所有 bot 都通过 Mikka 的 AI SDK / Workflow harness（即 Coordinator harness）处理对话和工具；派发的编码线程由 daemon 选择 Claude Code、Codex 或 Cursor CLI harness 执行。旧的独立 Agent 聊天已退役，历史记录仅供查看。让 Coordinator 本身跑在 Claude Code 或 Codex 上（[#312](docs/architecture/native-coordinator.md)）是已废弃的方案：代码保留但保持关闭，不要启用。

- **Coordinator 与你自建的 bot。**
  - Coordinator 是内置的 bot，常驻运行。当运行结束、任务状态变更或 worker 提出问题时，它会被唤醒并决定下一步操作，仅在需要你决策时发出通知。来自已连接应用的事项，它每天最多向你提起五次。
  - 你可以创建更多 bot，并为每个 bot 设定名称、形状和颜色。每个 bot 都运行在 Coordinator harness 上，拥有各自的对话、记忆和线程。这一 harness 与执行编码线程的 CLI harness 分开运行。

- **先确认，再执行。**
  - 派发之前，Coordinator 会把不清楚的需求交回给你，在对话中或以选项卡片的形式确认。
  - 运行过程中，worker 可以提出问题或报告阻塞。线程会等待你的回复，你的回答会送回该运行。

- **运行在你自己的设备上。**
  - Mikka daemon 可连接你的 Mac、Linux 主机或服务器。桌面应用也可以通过 SSH 把 daemon 安装到服务器上。
  - Daemon 通过你已安装并登录的 CLI harness 执行线程，因此沿用你现有的订阅与配置。

- **故障后自动恢复。**
  - 运行使用租约和 checkpoint。交接到拥有同一仓库的在线设备已有实现与测试，真实双机交接仍待验证。

- **融入现有工具。**
  - 其他 agent 可通过 MCP 操作 Mikka；在 Telegram 中发消息或在 Slack 中 @ 提及，即可联系 Coordinator。与 Linear 的双向同步已经完成，但处于关闭状态。

### 任务流转

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/task-flow-zh-dark.svg">
  <img src="docs/assets/task-flow-zh-light.svg" alt="任务在 Mikka 中的流转：来自对话、Telegram、Slack 或 MCP 的请求经过分诊；不清楚的请求交回给人补充细节，清楚的请求派发给编码 agent。Agent 可以请求澄清，并收到送回运行的答案。运行完成后交给审查与验证 agent，检查未通过时回到修复运行，通过后进入验收与发布，监控会把故障转为新 issue。">
</picture>

每一步都已在生产环境中运行。Factory 流程（接收与澄清、独立的审查与验证、检查未通过时的修复运行、验收与发布，以及监控）已在生产环境中开启；端到端验收仍在 [#192](https://github.com/alexj11324/Mikka/issues/192)、[#193](https://github.com/alexj11324/Mikka/issues/193) 和 [#195](https://github.com/alexj11324/Mikka/issues/195) 中跟踪。以合并 pull request 作为验收的方案在 [#528](https://github.com/alexj11324/Mikka/issues/528) 中规划。

## 当前功能

- **将需求转化为运行。** Coordinator 为你的任务派发运行，并判断每个新任务归属于工作区还是个人。如判断有误，可一键修改。Coordinator 也可以自行创建和更新任务。
- **自建 bot。** 左栏列出 Coordinator 和你创建的 bot。每个 bot 都有独立的对话、未读标记和动画头像。
- **完整呈现执行过程。** 派发出的线程会以卡片形式出现在对话中，并随运行实时更新；点开即可进入该线程自己的对话。Worker 通过 Mikka 的 MCP 工具汇报进度、提出问题或报告阻塞，由 Coordinator 逐一处理。你可以直接回复或停止自己的线程。
- **用图表和卡片回复。** Bot 使用 OpenUI 组件回复：柱状图、折线图、面积图、环形图和径向图，表格、统计数字、任务和运行标签，以及包含选项、开关、滑块和日期范围的问题卡片。
- **线程内容仅自己可见。** 在工作区任务上，同事只能看到线程的归属人、状态和时间，看不到指令、对话记录或结果。
- **注明信息来源。** 回复中引用的任务、运行记录和网页以可点击的标签形式展示。需要最新信息时，bot 可以搜索网页。
- **交付「Artifact」。** Bot 可以将文档或 HTML 页面作为「Artifact」交付，支持版本记录和分享链接。
- **通过 Factory 交付。** 任务接收与澄清、独立的审查与验证线程、检查未通过时的修复运行、以运行截图作为证据、任务上的验收视图，以及开出后续 issue 的监控。端到端验收仍在上文的 issue 中跟踪。
- **在已连接应用中操作。** Bot 可以提出邮件、Google 日历、Notion 和 Slack 操作，经你批准后执行。真实外部写入仍待端到端验收。
- **统一管理任务。** 任务支持看板和列表两种视图，包含关联关系、活动记录和个人任务编号。⌘K 可搜索 bot、历史对话、任务和项目。
- **判断哪些事需要你。** Mikka 按「置之不理的代价」为来自 GitHub、Linear、Notion 和 Gmail 的通知评级。紧急事项交给 Coordinator，它每天最多打扰你五次；其余事项留在「建议」中。每日简报会在你所在时区 08:00 之后发送到 Coordinator 对话中。
- **插件。** 一个「插件」页面（也显示在 设置 › 连接 中）列出你的应用（Gmail、Google 日历、Notion、Slack、GitHub、Linear 和 Telegram），并可搜索公开的 agent 技能。每个应用连接属于建立它的人。
- **应用内设置。** 设置在应用窗口内打开，包含账户、安全、偏好、通知、记忆、连接、模型、已保存的登录、隐私和设备等分区；工作区管理员另有通用、成员、团队、权限、密钥（包括工作区自己的 E2B API key）、审计日志、用量和计费。
- **计费。** 托管模型（Mikka 默认）需要先验证银行卡。验卡通过 Stripe Checkout 完成，首个使用该卡的工作区获得一次性 1 美元免费额度。预付点数通过 Stripe Checkout 充值到余额。使用自己的订阅、设备和 E2B key 无需银行卡。
- **管理设备。** 设置 › 设备列出你的电脑。移除在线设备时会同时卸载其 daemon。
- **支持从其他工具调用。** 可在 Claude Code 或 Codex 中通过 [MCP server](https://aspectlylabs.com/mikka/docs/mcp) 操作 Mikka，也可通过 Telegram 或 Slack 联系 Coordinator。
- **支持团队协作。** 提供工作区、成员、邀请和团队管理，支持邮箱、Google 和 GitHub 登录。邮箱登录有 kill switch；Google 和 GitHub 登录始终开启。
- **桌面应用。** 适用于 Apple Silicon 的 macOS 应用，在半透明窗口中渲染同一套界面，通过系统浏览器登录，在 Dock 和系统通知中提示等待中的运行，并从 GitHub Releases 自动更新。它还可以通过 SSH 添加 `~/.ssh/config` 中的服务器。
- **双语界面。** 应用提供英文和简体中文界面。

以下功能处于早期体验阶段，需开启 flag 或开关，或仍待验收：

- **云端电脑。** 每个 bot 拥有自己的云端桌面，使用工作区自己的 E2B key。支持实时查看、接管和交还控制权；你接管期间运行会暂停，空闲时自动休眠并保留磁盘数据。Bot 可以在其中启动网页分身，每个分身使用独立的浏览器。桌面操作遵守适用的授权策略。
- **使用自己的订阅。** 在设置中连接 ChatGPT（Codex）或 Claude 订阅，真实订阅支持的托管编码仍待验收。
- **已保存的登录。** 网页分身遇到登录页时，bot 会发送安全登录卡片。密码存入 KMS 加密的保管库，模型无法读取，之后同一网站可复用；你可以在设置中删除。默认开启；当前版本的真实环境验收仍待完成。
- **定时任务。** Bot 可以创建提醒、任务快照和只读 agent 任务，在指定时间或按周期运行。仍待验收（[#179](https://github.com/alexj11324/Mikka/issues/179)）。
- **关于你的记忆。** Mikka 从已评级的通知中提取关于你的信息，每晚合并，并在「记忆」中展示，每一条都可以修改或删除。
- **移动端应用。** [`apps/mobile`](apps/mobile) 中的 iOS 应用以 Coordinator 对话为核心，包含建议、线程、任务、设置和推送通知。尚未发布。

## 开发路线

目标授权流程由具备视觉能力的模型判断业务语义与行动。已有 auto-review 或 MCP 策略为 allow 时直接执行，ask 时请求确认，deny 时停止；鉴权、凭据保护、幂等和机械检查继续生效。敏感删除、安全设置等仍遵守适用策略的确认要求。此流程仍需实现和验收。

正在进行的工作在 [GitHub issues](https://github.com/alexj11324/Mikka/issues) 中跟踪。

| 方向 | 规划内容 | 跟踪 |
| --- | --- | --- |
| **云端电脑** | 上文的 bot 专属桌面处于早期体验阶段。下一步：每个云端线程拥有独立的机器（已在开关后完成，并设有按个人和按工作区的费用上限），以及向所有人开放托管编码线程。 | [#172](https://github.com/alexj11324/Mikka/issues/172) |
| **混合执行** | 本地 agent 将构建、测试和开发服务器交给 E2B 运行。 | [#572](https://github.com/alexj11324/Mikka/issues/572) |
| **群聊** | 支持多个 bot 与多名成员在同一对话中协作，提供轮流发言、@ 提及以及「正在工作」状态栏。后端已合入 main，界面尚未完成。 | [#105](https://github.com/alexj11324/Mikka/issues/105) |
| **Factory** | 已在生产环境运行；下一步：逐阶段完成端到端验收，并以合并 pull request 作为验收，取代单独的批准与发布步骤。 | [#192](https://github.com/alexj11324/Mikka/issues/192)、[#193](https://github.com/alexj11324/Mikka/issues/193)、[#195](https://github.com/alexj11324/Mikka/issues/195)、[#528](https://github.com/alexj11324/Mikka/issues/528) |
| **Connected apps** | 邮件、日历、Notion 和 Slack 审批后写入的真实环境验收。 | [#177](https://github.com/alexj11324/Mikka/issues/177) |
| **插件** | 个人 MCP server 和已安装技能已有后端和 Coordinator 工具，但还没有页面；工作区管理员可单独停用应用。 | [#595](https://github.com/alexj11324/Mikka/issues/595) |
| **自带模型 key** | 通过 Vercel AI Gateway 使用自己的模型 API key。 | [#589](https://github.com/alexj11324/Mikka/issues/589) |
| **主动建议** | 每晚的后台调研，根据你的截止日期和兴趣每天生成少量建议卡片，点击即可开始任务。 | [#350](https://github.com/alexj11324/Mikka/issues/350) |
| **体验优化** | 新用户引导和更完整的 ⌘K 搜索。 | [#129](https://github.com/alexj11324/Mikka/issues/129)、[#131](https://github.com/alexj11324/Mikka/issues/131) |

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
  <img src="docs/assets/architecture-zh-light.svg" alt="Mikka 架构：Web、桌面和 iOS 应用，Telegram、Slack，通知来源和 MCP 客户端接入 Vercel 上的 Next.js 应用，应用状态存储在 Postgres，支付通过 Stripe。每分钟 Worker 和应用事件唤醒 Coordinator，Coordinator 将运行派发给你的 Mac、Linux 主机或 SSH 主机上的 daemon，并唤醒每个 bot 的 E2B 云端电脑。编码 agent 通过 MCP 回报。Factory 阶段由监控驱动，位于 Coordinator 之上，审批后写入回到已连接应用。Linear 同步（已关闭）、托管运行和凭据保管库以虚线表示。">
</picture>

Web 应用、桌面和 iOS 应用、Telegram、Slack 和 MCP 客户端均接入部署在 Vercel 上的同一个 Next.js 应用。运行结束、worker 提问、已评级的通知等事件会发送给 Coordinator。Coordinator 是一个持久化 workflow，负责对每个事件进行分诊并决定下一步操作。所有 bot 都运行在同一个 workflow 上，各自拥有独立的对话、记忆和收件箱。

运行在你的设备上执行。Daemon 注册设备后，通过设备 API 领取运行，并在独立的 git worktree 中启动对应的 agent CLI。执行规则决定任务在哪里运行、使用哪个 harness 和模型，以及设备离线或额度用尽时如何处理。基于检查点的交接已有实现和测试；真实双机交接仍待验收。Agent 通过 Mikka 的 MCP worker 工具汇报进度、提出问题或报告阻塞。

Bot 的云端电脑是一个使用工作区自己 E2B key 的 E2B sandbox，运行同一个 daemon，并提供可通过 noVNC 查看的桌面。[`packages/subscription-worker`](packages/subscription-worker) 中的 Go 订阅 worker 保管你所连接订阅的登录凭据，密钥存放在 Infisical 中。[`services/credential-broker`](services/credential-broker) 中独立的凭据 broker 是唯一能解密已保存登录的组件，使用 AWS KMS。

托管模型通过 Vercel AI Gateway 运行并按次计量；验卡和充值通过 Stripe Checkout 及其 webhook 完成。

一个 Cloudflare Worker 每分钟触发一次，调用应用的 cron 路由：到期的 Coordinator 唤醒、定时任务、运行恢复和监控，每 15 分钟的简报，以及每小时的通知对账。Linear 同步运行在另一个 Worker 上，通过持久化的 inbox 和 outbox 与 Postgres 交换变更；它由 PostHog flag 关闭。

虚线框和虚线表示已关闭或仍待端到端验收的部分：Linear 同步、托管编码运行和凭据保管库。

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 应用 | Next.js 16、React 19、Tailwind CSS 4、shadcn/ui、ReUI，bot 回复使用 OpenUI |
| 桌面端 | [`apps/desktop`](apps/desktop) 中的 Electron 与 electron-updater（macOS，Apple Silicon） |
| 移动端 | [`apps/mobile`](apps/mobile) 中的 Expo 与 Expo Router（React Native） |
| Bot | Vercel AI SDK 与 AI Gateway；包括 Coordinator 在内的所有 bot 都是运行在 [Vercel Workflow](workflows/coordinator) 上的持久化循环 |
| 分诊 | 由具备能力的模型判断业务语义，按策略执行 allow / ask / deny，并保留机械安全检查；现有规则优先路由仍待调整和验收 |
| 数据 | Neon 托管的 Postgres，Drizzle 迁移位于 [`drizzle/`](drizzle) |
| 认证 | Better Auth，支持邮箱、Google 和 GitHub 登录，邮箱注册使用 Cloudflare Turnstile，并为 MCP 提供 OAuth 2.1 server |
| 计费 | Stripe Checkout 与 webhook |
| Flag | PostHog |
| 集成 | GitHub 与 Linear 使用 webhook；Gmail、Google 日历、Notion、Slack 通过 Composio 接入；定时工作和 Linear 同步运行在 Cloudflare Worker 上；Telegram 和 Slack 基于 Vercel Chat SDK；网页搜索使用 Firecrawl |
| 云端电脑 | E2B sandbox 与 noVNC 桌面 |
| 凭据 | 使用 AWS KMS 信封加密的凭据 broker；项目密钥存放在 Infisical |
| 订阅 | [`packages/subscription-worker`](packages/subscription-worker) 中的 Go worker，密钥存放在 Infisical（早期体验） |
| 执行 harness | Mikka daemon 为每个工作线程选择 Claude Code、Codex 或 Cursor CLI 适配器 |

## 目录结构

```text
app/                 # Next.js 路由、server actions 与 API（MCP、webhook、cron、daemon /v1）
components/          # React 界面组件
lib/                 # 业务逻辑：Coordinator、任务、计费、Factory、云端电脑、MCP、认证
workflows/           # 持久化 workflow（Coordinator、Slack、网页分身、线程机器、运行发布）
agents/              # 内置 bot 定义
apps/desktop/        # macOS 桌面应用（Electron）
apps/mobile/         # iOS 应用（Expo）
packages/daemon/     # 本地 daemon 和 CLI 执行 harness 适配器
packages/protocol/   # 服务端、daemon 与桌面应用共用的类型定义
packages/config/     # 共享配置
packages/subscription-worker/  # 管理已连接订阅的 Go worker
services/credential-broker/    # 为保管库解密已保存的登录
cloudflare/          # Cloudflare Worker：每分钟 cron 与 Linear 同步
drizzle/             # 数据库迁移
messages/, i18n/     # 英文与简体中文文案
tests/               # 单元测试、验收测试与 Playwright 测试
docs/                # 工程与设计文档
factory.yaml         # 经过审查的 Factory 定义
```

## 开发

开发和功能验收在云端 Linux 中进行，使用本地应用、真实的隔离 Postgres 数据库，必要时使用真实的 daemon。构建、类型检查和端到端测试在云端 Linux 或 CI 中运行。凭据统一存放在 Infisical Cloud，不得提交至仓库或写入本地 `.env` 文件。

安装依赖并运行源码检查：

```sh
pnpm install
pnpm check
```

初始化隔离的测试数据库，并在 `http://127.0.0.1:3000/mikka` 启动应用：

```sh
pnpm test:e2e:setup
pnpm dev
```

桌面外壳会加载这个本地应用：

```sh
pnpm desktop:dev
```

开发过程中，运行 `pnpm typecheck`、`pnpm lint`、所改动部分的单元测试，以及所改动流程对应的一个浏览器测试。Pull request 运行 `@smoke` 浏览器测试集和所涉及区域的 spec；推送到 main 时运行主功能测试列表；每晚运行全部 spec。详见 [`CONTRIBUTING.md`](CONTRIBUTING.md)（"How changes are tested"）。

建议首先阅读以下文档：

- [`AGENTS.md`](AGENTS.md)：所有贡献者和 coding agent 须遵守的规则。
- [`docs/design/README.md`](docs/design/README.md)：进行任何设计、spec 或 UI 工作前必读。
- [`docs/design/glossary.md`](docs/design/glossary.md)：bot、线程与对话的定义。
- [`docs/acceptance.md`](docs/acceptance.md)：变更的验收流程。
- [`docs/acceptance-mvp-core-loop.md`](docs/acceptance-mvp-core-loop.md)：MVP 测试边界，以及待完成的 CI / 受阻的 Preview 验收记录。
- [`docs/review-checklist.md`](docs/review-checklist.md)：向他人展示 UI 前须完成的检查项。
- [`apps/desktop/README.md`](apps/desktop/README.md)：桌面应用的运行与打包。

## 获取访问权限

Mikka 目前处于早期体验阶段。请发送邮件至 [mikka@aspectlylabs.com](mailto:mikka@aspectlylabs.com) 申请邀请，然后参照 [快速入门](https://aspectlylabs.com/mikka/docs/quickstart) 开始使用。

## 许可证

Mikka 采用 [AGPL-3.0-only](LICENSE) 协议开源。第三方组件遵循各自的许可证，详见 [`packages/daemon/THIRD_PARTY_NOTICES.md`](packages/daemon/THIRD_PARTY_NOTICES.md)。

如果你将修改后的 Mikka 作为网络服务提供给他人使用，AGPL 要求你向这些用户提供所部署版本的源代码。

## 参与贡献

欢迎参与贡献，请先阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md)。贡献的代码按照项目的 [AGPL-3.0-only](LICENSE) 协议授权，无需另行签署贡献者协议；贡献者保留其作品的版权。
