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

Mikka coordinates the coding agents you already use as a single team. Describe
what you need to a bot in natural language. The bot breaks the request into
tasks and assigns coding work to Claude Code, Codex or Cursor on your own
machines. A bot can also have a cloud desktop; hosted coding runs still await
real provider acceptance.

You can follow each task in real time, step in when a decision is needed, and
review the results.

## How Mikka works

- **Bots coordinate. Threads execute.**
  - A bot chats with you, plans the work and hands it out. It does not do the
    work directly.
  - The left column lists your bots, and the Coordinator is one of them. You
    can create a bot with a name, colour and shape; each bot has its own
    conversation, memory, inbox and lease.
  - Each piece of work runs in a **thread**: one work run with its own name,
    usually tied to a task. One bot can run many threads at once.
  - The full definitions are in the [glossary](docs/design/glossary.md).
  - A **harness** is the execution layer, not another bot. Bots use Mikka's AI SDK / Workflow harness for chat and tools; dispatched coding work uses the daemon's Claude Code, Codex or Cursor CLI harness. The retired standalone Agent chat is available only as read-only history.

- **One harness for every bot.**
  - The Coordinator is a long-running bot. It wakes when a run ends, a task
    changes state, or a worker asks a question, decides the next step, and
    notifies you only when your input is required.
  - Its orchestration harness is separate from the CLI harnesses that execute
    dispatched coding threads, and every bot you create chats on that same
    harness.

- **Asks before it guesses.**
  - The Coordinator can ask for missing details in chat. Systematic routing
    of ambiguous requests is still in progress.
  - A worker can ask a question or report that it is blocked. Durable routing
    of a person’s answer back to the waiting run is still being verified.

- **Runs on your machines or a cloud computer.**
  - The Mikka daemon connects your Mac, Linux machine or server.
  - A bot can also get a cloud computer: its own desktop, which you can watch
    live, take control of, and hand back. It sleeps when idle and keeps its
    disk.
  - On your machines, work starts through the CLI harnesses you have already
    installed and signed in to, so your existing plans and settings apply.

- **Recovers from failures.**
  - Runs use leases and checkpoints. Recovery on another connected machine
    with the same repository is implemented and tested, but a real two-machine
    handover remains to be verified.

- **Fits into your existing tools.**
  - Tasks sync both ways with Linear, other agents can operate Mikka through
    MCP, and you can send requests from Telegram or Slack.

### How a task moves

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/task-flow-dark.svg">
  <img src="docs/assets/task-flow-light.svg" alt="How a task moves through Mikka: a request is triaged and dispatched; clarification routing, answers to a waiting run and Factory stages are pending completion or acceptance.">
</picture>

Solid lines show connected paths; dashed lines include planned work and paths
that still need end-to-end acceptance. Returning an answer to a waiting run
needs verification. The dashed Factory loop includes independent review and verification
([#193](https://github.com/alexj11324/Mikka/issues/193)), a fix run when a check fails, release approval by a person
([#194](https://github.com/alexj11324/Mikka/issues/194)), and monitoring that turns incidents into issues
([#195](https://github.com/alexj11324/Mikka/issues/195)). Systematic routing of ambiguous requests is tracked in
[#192](https://github.com/alexj11324/Mikka/issues/192).

## What Mikka does today

- **Turns requests into tasks.** The Coordinator breaks a request into tasks,
  dispatches runs, and decides whether each task belongs to the workspace or to
  you. You can change the assignment in one click.
- **Creates bots.** Each bot gets its own conversation, memory, inbox and lease,
  and runs on the same harness as the Coordinator.
- **Works in the cloud.** A bot can get its own desktop, watch it live, take
  control of it, and hand it back. It sleeps when idle and keeps its disk.
- **Makes progress visible.** Every thread shows what its agent
  is doing. Workers can report progress, ask questions and flag blocks through
  Mikka's MCP tools; durable answer routing remains under verification.
- **Cites its sources.** Replies show the tasks, runs and web pages they draw
  on as chips you can open.
- **Keeps tasks in one place.** Tasks show on a board and a list, with
  relations, activity history and per-person task numbers. They sync both ways
  with Linear.
- **Finds anything with ⌘K.** Search bots, chats, tasks and projects from the
  keyboard.
- **Filters notifications.** Mikka collects notifications from GitHub, Linear,
  Notion, Slack and Gmail, surfaces only those that need your attention, and
  writes a daily briefing.
- **Acts in your apps, after your approval.** The Coordinator can propose email
  and Google Calendar actions for approval. The approval path is implemented; real external writes still need end-to-end acceptance.
- **Works from other tools.** Operate Mikka from Claude Code or Codex through its
  [MCP server](https://aspectlylabs.com/mikka/docs/mcp).
- **Supports teams.** Workspaces, members, invitations and teams, with Google
  and GitHub sign-in.
- **Bilingual interface.** The app is available in English and Simplified Chinese.

## What we're building

Work in progress is tracked in
[GitHub issues](https://github.com/alexj11324/Mikka/issues), mirrored from
Linear (`MIK-xx`).

| Area | Planned | Tracking |
| --- | --- | --- |
| **iOS app** | The Coordinator chat, threads, tasks and settings on iPhone. The app is wired to the server; TestFlight acceptance is pending. | [PR #340](https://github.com/alexj11324/Mikka/pull/340) |
| **Group chats** | Multiple bots and people in one chat, with turn-taking, @ mentions and a status bar showing who is working. | [#105](https://github.com/alexj11324/Mikka/issues/105) |
| **Factory** | An end-to-end delivery process: one run per task at a time, durable stage state, independent review and verification threads, and human release approval based on recorded evidence. | [#191](https://github.com/alexj11324/Mikka/issues/191)–[#195](https://github.com/alexj11324/Mikka/issues/195) |
| **Scheduled tasks** | Bots run tasks at a set time or on a recurring schedule and report the results in chat. | [#179](https://github.com/alexj11324/Mikka/issues/179) |
| **Connected apps** | Documents and Slack actions, and workflows beyond mail and calendar, subject to the same per-action approval. | [#177](https://github.com/alexj11324/Mikka/issues/177) |
| **Secure credentials** | Agents request credentials through a secure form. A vault holds them, and a controlled browser uses them only for approved actions. | [#180](https://github.com/alexj11324/Mikka/issues/180) |
| **Usability** | Onboarding, site-wide search across pages and content, a knowledge base, web search for agents, and team visibility settings. | [#129](https://github.com/alexj11324/Mikka/issues/129), [#131](https://github.com/alexj11324/Mikka/issues/131), [#134](https://github.com/alexj11324/Mikka/issues/134), [#100](https://github.com/alexj11324/Mikka/issues/100), [#127](https://github.com/alexj11324/Mikka/issues/127) |

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
  <img src="docs/assets/architecture-light.svg" alt="Mikka architecture: the web app, Telegram, Slack and MCP clients reach the Next.js app on Vercel; the Coordinator dispatches runs to the daemon and can wake a bot's cloud computer; hosted coding runs and approved mail and calendar writes await acceptance; agents report through MCP; state lives in Postgres and syncs with Linear.">
</picture>

The web app, Telegram, Slack and MCP clients all reach the same Next.js
application on Vercel. Events such as a finished run or a worker question go to
the Coordinator, a durable workflow that triages each event and decides the next
step.

On your machine, the daemon registers the device, claims runs through the device
API, and starts the agent CLI in a dedicated git worktree. The Coordinator can
wake a bot's E2B desktop; a person can view it, take control and hand it back.
A hosted worker is implemented, but a real subscription-backed coding task has
not yet been verified. Checkpoint-based handover has tests; a real two-machine
handover remains to be verified.

The Coordinator can propose mail and calendar actions for approval. Actual
external writes still need end-to-end acceptance.

Linear sync runs in a Cloudflare Worker that exchanges changes with Postgres
through a durable inbox and outbox.

Dashed boxes and lines are planned or awaiting end-to-end acceptance, including
hosted coding, answer routing and approved mail/calendar writes. Other roadmap
items include the Scheduler
([#179](https://github.com/alexj11324/Mikka/issues/179)), Factory stages ([#191](https://github.com/alexj11324/Mikka/issues/191)–[#194](https://github.com/alexj11324/Mikka/issues/194)), Monitoring
([#195](https://github.com/alexj11324/Mikka/issues/195)), local computer use
([#147](https://github.com/alexj11324/Mikka/issues/147)), connected-app workflows beyond mail and calendar
([#177](https://github.com/alexj11324/Mikka/issues/177)) and the credential vault ([#180](https://github.com/alexj11324/Mikka/issues/180)).

## Built with

| Layer | Stack |
| --- | --- |
| App | Next.js 16, React 19, Tailwind CSS 4, shadcn/ui, ReUI |
| Bots | Vercel AI SDK; the Coordinator is a durable loop on [Vercel Workflow](workflows/coordinator) |
| Triage | Rules first, then a model call through Vercel AI Gateway with a monthly cost cap |
| Data | Postgres on Neon, Drizzle migrations in [`drizzle/`](drizzle) |
| Auth | Better Auth, with Google and GitHub sign-in and an OAuth 2.1 server for MCP |
| Integrations | GitHub and Linear webhooks; Composio for Gmail, Google Calendar, Notion and Slack, with approval-based mail and calendar writes awaiting external acceptance; Cloudflare Workers for Linear sync and scheduled briefings; Vercel Chat SDK for Telegram and Slack |
| Execution harnesses | The Mikka daemon selects a Claude Code, Codex or Cursor CLI adapter for each work thread; a hosted worker for per-bot E2B desktops awaits real provider acceptance |

## Repository layout

```text
agents/              # Built-in Bot definitions and Skills
app/                 # Next.js routes, server actions and API (MCP, webhooks, daemon /v1)
apps/mobile/         # Expo iOS app
components/          # React UI
lib/                 # Domain logic: coordinator, issues, Linear sync, MCP, auth, cloud computer
workflows/           # Durable workflows (the Coordinator and Slack)
packages/daemon/     # Local daemon and CLI execution harness adapters
packages/protocol/   # Types shared by the server and the daemon
packages/config/     # Shared configuration
packages/subscription-worker/  # Subscription enrollment and hosted run worker
cloudflare/          # Workers for Linear sync and scheduled briefings
drizzle/             # Database migrations
messages/, i18n/     # English and Simplified Chinese strings
tests/               # Unit, acceptance and Playwright tests
docs/                # Engineering and design docs
```

## Development

Mikka is developed against cloud Preview deployments, not a local server.
Builds, type checks and end-to-end tests run in CI, and each pull request gets
its own Preview URL. Credentials live in Infisical Cloud; never commit them or
store them in a local `.env` file.

Install dependencies and run the checks that do not require a server:

```sh
pnpm install
pnpm check
```

`pnpm check:ci` is the full CI gate: `check`, plus the production build,
performance tests and Playwright tests.

Start with these documents:

- [`AGENTS.md`](AGENTS.md): the rules every contributor and coding agent follows.
- [`docs/design/README.md`](docs/design/README.md): read before any design,
  spec or UI work.
- [`docs/design/glossary.md`](docs/design/glossary.md): what bot, thread and
  chat mean.
- [`docs/acceptance.md`](docs/acceptance.md): how a change is accepted on a
  Preview.
- [`docs/review-checklist.md`](docs/review-checklist.md): complete before
  presenting UI to others.

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
