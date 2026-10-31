<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/brand/mikka-icon-dark.svg">
  <img src="public/brand/mikka-icon-light.svg" alt="Mikka" width="112">
</picture>

# Mikka

### The AI lead for ambitious work.

Every agent, from laptop to cloud, working as one team.

[![CI](https://github.com/alexj11324/Mikka/actions/workflows/ui-policy.yml/badge.svg?branch=main)](https://github.com/alexj11324/Mikka/actions/workflows/ui-policy.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![LINUX DO](https://img.shields.io/badge/LINUX%20DO-Community-FFB003)](https://linux.do)

[Open Mikka](https://app.aspectlylabs.com/mikka) · [Docs](https://aspectlylabs.com/mikka/docs) · [Quickstart](https://aspectlylabs.com/mikka/docs/quickstart)

**English** · [简体中文](README.zh-CN.md)

</div>

Mikka connects AI agents across your computers, remote servers and cloud
infrastructure into one coordinated team. Describe the work to a bot, and it
organizes coding tasks for Claude Code, Codex and Cursor on connected devices.
Cloud desktops support viewing, takeover and handback; real subscription-backed
hosted coding tasks still await acceptance.

Track progress, respond when needed and review results in one place, on the web
or in the macOS desktop app.

## How Mikka works

- **Bots coordinate. Threads execute.**
  - A bot chats with you, plans the work and dispatches coding tasks to
    agents across connected devices.
  - Each piece of work runs in a **thread**: one work run with its own name,
    usually tied to a task. One bot can run many threads at once.
  - The full definitions are in the [glossary](docs/design/glossary.md).
  - A **harness** is the execution layer, not another bot. Every bot chats on Mikka's AI SDK / Workflow harness (the Coordinator harness); dispatched coding work uses the daemon's Claude Code, Codex or Cursor CLI harness. The retired standalone Agent chat is available only as read-only history. Running the Coordinator itself on Claude Code or Codex ([#312](docs/architecture/native-coordinator.md)) is a deprecated design: the code is kept switched off and must not be enabled.

- **The Coordinator and your own bots.**
  - The Coordinator is the built-in bot. It is long-running: it wakes when a
    run ends, a task changes state, or a worker asks a question, decides the
    next step, and notifies you only when your input is required. It raises
    matters from your connected apps at most five times a day.
  - You can create more bots, each with its own name, shape and colour. Every
    bot chats on the Coordinator harness with its own chat, memory and
    threads. That harness is separate from the CLI harnesses that execute
    dispatched coding threads.

- **Asks before it guesses.**
  - The Coordinator can ask for missing details in chat, including as a choice
    card before it dispatches. Systematic routing of ambiguous requests is built
    behind the Factory switches and still needs acceptance.
  - A worker can ask a question or report that it is blocked. A thread can wait
    for your reply; resuming the same run with your answer is still being
    verified.

- **Runs on your own machines.**
  - The Mikka daemon connects your Mac, Linux machine or server. The desktop
    app can also install it on a server over SSH.
  - It starts work through the CLI harnesses you have already installed and signed in
    to, so your existing plans and settings apply.

- **Recovers from failures.**
  - Runs use leases and checkpoints. Recovery on another connected machine
    with the same repository is implemented and tested, but a real two-machine
    handover remains to be verified.

- **Fits into your existing tools.**
  - Other agents can operate Mikka through MCP, and a Telegram message or a
    Slack mention reaches the Coordinator. Two-way Linear sync is built but
    switched off.

### How a task moves

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/task-flow-dark.svg">
  <img src="docs/assets/task-flow-light.svg" alt="How a task moves through Mikka: a request from chat, Telegram, Slack or MCP is triaged and dispatched to a coding agent, which can ask the Coordinator for clarification. Pre-dispatch clarification, answers returned to a waiting run and the Factory loop of review, verification, acceptance and monitoring are dashed as pending.">
</picture>

Solid lines show connected paths; dashed lines include planned work and paths
that still need end-to-end acceptance. Returning an answer to a waiting run
needs verification. The dashed Factory loop includes independent review and
verification ([#193](https://github.com/alexj11324/Mikka/issues/193)), a fix
run when a check fails, acceptance of the pull request
([#528](https://github.com/alexj11324/Mikka/issues/528)), and monitoring that
turns incidents into issues
([#195](https://github.com/alexj11324/Mikka/issues/195)). Systematic routing of
ambiguous requests is tracked in
[#192](https://github.com/alexj11324/Mikka/issues/192).

## What Mikka does today

- **Turns requests into runs.** The Coordinator dispatches runs for your tasks
  and decides whether each new task belongs to the workspace or to you. You can
  change the assignment in one click. Letting the Coordinator create and update
  tasks itself is built but behind a switch that is off by default.
- **Lets you create bots.** The left column lists the Coordinator and the bots
  you create. Each bot has its own chat, with unread markers and an animated
  avatar.
- **Makes progress visible.** A dispatched thread appears in the chat as a card
  that follows the run; open it to see the thread's own conversation. Workers
  report progress, ask questions and flag blocks through Mikka's MCP tools,
  and the Coordinator triages each one. You can reply to or stop your thread
  directly.
- **Answers with charts and cards.** Bots reply with OpenUI components: bar,
  line, area, donut and radial charts, tables, stats, task and run chips, and
  question cards with choices, switches, sliders and date ranges.
- **Keeps threads private.** On a workspace task, teammates see whose thread it
  is, its status and its time, but not its instructions, transcript or result.
- **Cites its sources.** Replies show the tasks, runs and web pages they draw
  on as chips you can open. Bots can search the web when they need current
  information.
- **Hands back Artifacts.** A bot can deliver a document or an HTML page as an
  Artifact, with versions and a share link.
- **Acts in your apps.** Bots propose email, Google Calendar, Notion and Slack
  actions, which run after your approval. Real external writes still need
  end-to-end acceptance.
- **Keeps tasks in one place.** Tasks show on a board and a list, with
  relations, activity history and per-person task numbers. ⌘K searches bots,
  older chats, tasks and projects.
- **Decides what needs you.** Mikka rates notifications from GitHub, Linear,
  Notion and Gmail by what it costs to ignore them. Urgent matters go to the
  Coordinator, which interrupts you at most five times a day; the rest wait in
  Suggestions. A daily briefing arrives in the Coordinator chat after 08:00 in
  your time zone.
- **Plugins.** One 插件 page, also shown in Settings › Connections, lists your
  apps (Gmail, Google Calendar, Notion, Slack, GitHub, Linear and Telegram)
  and searches public agent skills. Each app connection belongs to the person
  who made it.
- **Settings inside the app.** Settings open in the app window, with sections
  for account, security, preferences, notifications, memory, connections,
  models, saved logins, privacy and devices, and for workspace admins general,
  members, teams, permissions, secrets (including the workspace's own E2B API
  key), audit log, usage and billing.
- **Billing.** The hosted model (Mikka 默认) needs a verified card. Card
  verification is Stripe Checkout and grants a one-off $1 free allowance (免费额度)
  to the first workspace using that card. Prepaid points top up the balance
  (余额) through Stripe Checkout. Your own subscriptions, devices and E2B key
  need no card.
- **Manages devices.** Settings › Devices lists your computers. Removing an
  online device also uninstalls its daemon.
- **Works from other tools.** Operate Mikka from Claude Code or Codex through its
  [MCP server](https://aspectlylabs.com/mikka/docs/mcp), or reach the
  Coordinator from Telegram or Slack.
- **Supports teams.** Workspaces, members, invitations and teams, with email,
  Google and GitHub sign-in. Email sign-in has a kill switch; Google and GitHub
  stay on.
- **Desktop app.** A macOS app for Apple Silicon renders the same UI in a
  translucent window, signs in through the system browser, shows waiting runs
  in the Dock and system notifications, and updates itself from GitHub
  Releases. It also enrolls servers from your `~/.ssh/config` over SSH.
- **Bilingual interface.** The app is available in English and Simplified Chinese.

In early access, behind a flag or switch, or awaiting acceptance:

- **Cloud computer.** Each bot gets its own cloud desktop on the workspace's
  own E2B key. You can watch it live, take control and hand it back; runs pause
  while you hold it, it sleeps when idle and keeps its disk. Bots can start web
  sub-agents there, each in its own browser. Bot desktop actions follow the
  applicable authorization policy.
- **Your own subscriptions.** Connect a ChatGPT (Codex) or Claude subscription in
  Settings. Real subscription-backed hosted coding still awaits acceptance.
- **Saved logins.** When a web sub-agent reaches a login page, the bot sends a
  secure login card. The password goes to a KMS-encrypted vault that the model
  never reads, and is reused for that site; you can delete it in Settings. On
  by default; live acceptance at the current version is pending.
- **Scheduled tasks.** Bots can create reminders, task snapshots and read-only
  agent tasks that run at a set time or on a schedule. Acceptance is pending
  ([#179](https://github.com/alexj11324/Mikka/issues/179)).
- **Factory.** Task intake, clarification, independent review and verification
  threads, run captures as evidence, and an acceptance view on the task. Built
  behind two switches that are off by default; acceptance is pending.
- **Memory of you.** Mikka reads rated notifications for facts about you, merges
  them nightly, and shows them in Memory, where you can correct or delete each
  one.
- **Mobile app.** An iOS app in [`apps/mobile`](apps/mobile), built around the
  Coordinator chat, with suggestions, threads, tasks, settings and push
  notifications. Not yet released.

## What we're building

The intended authorization flow uses a vision-capable model to judge business
meaning and actions. An existing auto-review or MCP policy of allow permits
execution; ask requests confirmation, and deny stops. Authentication,
credential protection, idempotency and mechanical checks remain in force.
Sensitive deletion and security settings still require confirmation when policy
requires it. This flow remains subject to implementation and acceptance.

Work in progress is tracked in
[GitHub issues](https://github.com/alexj11324/Mikka/issues).

| Area | Planned | Tracking |
| --- | --- | --- |
| **Cloud computer** | The per-bot desktop above is in early access. Next: each cloud thread on a machine of its own (built behind a switch, with per-owner and per-workspace spend limits), and hosted coding threads turned on for everyone. | [#172](https://github.com/alexj11324/Mikka/issues/172) |
| **Hybrid execution** | Local agents offload builds, tests and dev servers to E2B. | [#572](https://github.com/alexj11324/Mikka/issues/572) |
| **Group chats** | Multiple bots and people in one chat, with turn-taking, @ mentions and a status bar showing who is working. The backend is on main; the interface is not. | [#105](https://github.com/alexj11324/Mikka/issues/105) |
| **Factory** | An end-to-end delivery process: durable stage state, independent review and verification threads, acceptance by merging the pull request, and monitoring. Built behind switches; see above. | [#192](https://github.com/alexj11324/Mikka/issues/192), [#193](https://github.com/alexj11324/Mikka/issues/193), [#195](https://github.com/alexj11324/Mikka/issues/195), [#528](https://github.com/alexj11324/Mikka/issues/528) |
| **Connected apps** | Live acceptance of the approved email, calendar, Notion and Slack writes. | [#177](https://github.com/alexj11324/Mikka/issues/177) |
| **Plugins** | Personal MCP servers and installed skills have a backend and Coordinator tools but no page yet; workspace admins switching single apps off. | [#595](https://github.com/alexj11324/Mikka/issues/595) |
| **Your own model keys** | Bring-your-own model API keys routed through Vercel AI Gateway. | [#589](https://github.com/alexj11324/Mikka/issues/589) |
| **Proactive suggestions** | A nightly research run that turns your deadlines and interests into a few suggestion cards a day, which start a task when tapped. | [#350](https://github.com/alexj11324/Mikka/issues/350) |
| **Usability** | Onboarding and fuller ⌘K search. | [#129](https://github.com/alexj11324/Mikka/issues/129), [#131](https://github.com/alexj11324/Mikka/issues/131) |

## Connect your agents

### Operate Mikka through MCP

Mikka is an MCP server (Streamable HTTP, OAuth 2.1). Add it to Claude Code:

```sh
claude mcp add --transport http mikka https://app.aspectlylabs.com/mikka/api/mcp
```

Claude Code completes sign-in in your browser. Agents can then read and modify
tasks, dispatch runs and update the Coordinator's memory. Other clients and the
full tool list are in the [MCP docs](https://aspectlylabs.com/mikka/docs/mcp).

### Run coding harnesses on your own machine

The daemon in [`packages/daemon`](packages/daemon) detects the coding harness CLIs on
the machine and runs threads through them:

| Execution harness | CLI it looks for |
| --- | --- |
| Claude Code | `claude` |
| Codex | `codex` |
| Cursor | `cursor-agent` or `agent` |

Each run uses its own git worktree, so parallel threads stay isolated.

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture-dark.svg">
  <img src="docs/assets/architecture-light.svg" alt="Mikka architecture: the web, desktop and iOS apps, Telegram, Slack, notification sources and MCP clients reach the Next.js app on Vercel, which keeps state in Postgres and takes payments through Stripe. A minute Worker and app events wake the Coordinator, which dispatches runs to the daemon on your Mac, Linux machine or SSH host and wakes each bot's E2B cloud computer. Coding agents report back through MCP. Linear sync, Factory stages, monitoring, hosted runs, approved writes and the credential vault are dashed as pending or switched off.">
</picture>

The web app, the desktop and iOS apps, Telegram, Slack and MCP clients all reach
the same Next.js application on Vercel. Events such as a finished run, a worker
question or a rated notification go to the Coordinator, a durable workflow
that triages each event and decides the next step. Every bot runs on the same
workflow, each with its own chat, memory and inbox.

Runs execute on your machines. The daemon registers the device, claims runs
through the device API, and starts the agent CLI in a dedicated git worktree.
Execution rules choose where a task runs, which harness and which model, and
what happens when a device is offline or a quota runs out.
Checkpoint-based handover is implemented and tested; a real two-machine
handover remains to be verified.
The agent reports progress, questions and blocks through Mikka's MCP worker
tools.

A bot's cloud computer is an E2B sandbox on the workspace's own E2B key, running
the same daemon and a desktop you can view through noVNC. A Go subscription
worker in [`packages/subscription-worker`](packages/subscription-worker) holds
the sign-in for subscriptions you connect, with the secrets kept in Infisical.
A separate credential broker in
[`services/credential-broker`](services/credential-broker) is the only part
that decrypts saved logins, using AWS KMS.

The hosted model runs through Vercel AI Gateway and is metered per call; card
verification and top-ups go through Stripe Checkout and its webhooks.

A Cloudflare Worker fires every minute and calls the app's cron routes: due
Coordinator wakes, schedules, run recovery and monitoring, briefings every
15 minutes, and hourly notification reconciliation. Linear sync runs in a
second Worker that exchanges changes with Postgres through a durable inbox and
outbox; it is switched off by a PostHog flag.

Dashed boxes and lines are planned, awaiting end-to-end acceptance, or switched
off: Linear sync, Factory stages and monitoring, hosted coding runs, approved
writes to connected apps and the credential vault.

## Built with

| Layer | Stack |
| --- | --- |
| App | Next.js 16, React 19, Tailwind CSS 4, shadcn/ui, ReUI, OpenUI for bot replies |
| Desktop | Electron with electron-updater in [`apps/desktop`](apps/desktop) (macOS, Apple Silicon) |
| Mobile | Expo and Expo Router (React Native) in [`apps/mobile`](apps/mobile) |
| Bots | Vercel AI SDK and AI Gateway; every bot, including the Coordinator, is a durable loop on [Vercel Workflow](workflows/coordinator) |
| Triage | A capable model judges business meaning; policy controls allow / ask / deny and mechanical checks protect execution. Current rules-first routing remains to be updated and accepted |
| Data | Postgres on Neon, Drizzle migrations in [`drizzle/`](drizzle) |
| Auth | Better Auth, with email, Google and GitHub sign-in, Cloudflare Turnstile on email sign-up, and an OAuth 2.1 server for MCP |
| Billing | Stripe Checkout and webhooks |
| Flags | PostHog |
| Integrations | GitHub and Linear webhooks; Composio for Gmail, Google Calendar, Notion and Slack; Cloudflare Workers for scheduled work and Linear sync; Vercel Chat SDK for Telegram and Slack; Firecrawl for web search |
| Cloud computer | E2B sandboxes with a noVNC desktop |
| Credentials | A credential broker with AWS KMS envelope encryption; project secrets in Infisical |
| Subscriptions | A Go worker in [`packages/subscription-worker`](packages/subscription-worker), with secrets in Infisical (early access) |
| Execution harnesses | The Mikka daemon selects a Claude Code, Codex or Cursor CLI adapter for each work thread |

## Repository layout

```text
app/                 # Next.js routes, server actions and API (MCP, webhooks, cron, daemon /v1)
components/          # React UI
lib/                 # Domain logic: coordinator, issues, billing, factory, computer, MCP, auth
workflows/           # Durable workflows (Coordinator, Slack, sub-agents, thread machines, run publication)
agents/              # Built-in bot definitions
apps/desktop/        # macOS desktop app (Electron)
apps/mobile/         # iOS app (Expo)
packages/daemon/     # Local daemon and CLI execution harness adapters
packages/protocol/   # Types shared by the server, the daemon and the desktop app
packages/config/     # Shared configuration
packages/subscription-worker/  # Go worker for connected subscriptions
services/credential-broker/    # Decrypts saved logins for the vault
cloudflare/          # Cloudflare Workers: the minute cron and Linear sync
drizzle/             # Database migrations
messages/, i18n/     # English and Simplified Chinese strings
tests/               # Unit, acceptance and Playwright tests
docs/                # Engineering and design docs
factory.yaml         # The reviewed Factory definition
```

## Development

Development and functional acceptance run in cloud Linux against a local
application, a real isolated Postgres database and, when relevant, a real
daemon. Builds, type checks and end-to-end tests run there or in CI.
Credentials live in Infisical Cloud; never commit them or store them in a local
`.env` file.

Install dependencies and run the source checks:

```sh
pnpm install
pnpm check
```

Set up the isolated test database and start the app at
`http://127.0.0.1:3000/mikka`:

```sh
pnpm test:e2e:setup
pnpm dev
```

The desktop shell loads that local app:

```sh
pnpm desktop:dev
```

While working, run `pnpm typecheck`, `pnpm lint`, the unit tests for what you
changed and the one browser test for a flow you changed. A pull request runs
the `@smoke` browser set plus the specs of the areas it touches; a push to
main runs the main functional list; nightly runs cover every spec. See
[`CONTRIBUTING.md`](CONTRIBUTING.md) ("How changes are tested").

Start with these documents:

- [`AGENTS.md`](AGENTS.md): the rules every contributor and coding agent follows.
- [`docs/design/README.md`](docs/design/README.md): read before any design,
  spec or UI work.
- [`docs/design/glossary.md`](docs/design/glossary.md): what bot, thread and
  chat mean.
- [`docs/acceptance.md`](docs/acceptance.md): how a change is accepted.
- [`docs/acceptance-mvp-core-loop.md`](docs/acceptance-mvp-core-loop.md): the MVP
  test boundaries and pending CI / blocked Preview acceptance record.
- [`docs/review-checklist.md`](docs/review-checklist.md): complete before
  presenting UI to others.
- [`apps/desktop/README.md`](apps/desktop/README.md): running and packaging
  the desktop app.

## Get access

Mikka is in early access. Email
[mikka@aspectlylabs.com](mailto:mikka@aspectlylabs.com) for an invite, then
follow the [Quickstart](https://aspectlylabs.com/mikka/docs/quickstart).

## License

Mikka is licensed under [AGPL-3.0-only](LICENSE). Third-party components keep
their own licenses; see
[`packages/daemon/THIRD_PARTY_NOTICES.md`](packages/daemon/THIRD_PARTY_NOTICES.md).

If you run a modified version of Mikka as a network service, the AGPL requires
you to offer its users the source code of your version.

## Contributing

Contributions are welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first.
Contributions are made under the project's [AGPL-3.0-only](LICENSE) license;
no separate contributor agreement is required.
