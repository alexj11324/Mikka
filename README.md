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
tasks and assigns each one to Claude Code, Codex or Cursor. Tasks run on your
own machines today; cloud computers are coming soon.

You can follow each task in real time, step in when a decision is needed, and
review the results.

## How Mikka works

- **Bots coordinate. Threads execute.**
  - A bot chats with you, plans the work and hands it out. It does not do the
    work directly.
  - Each piece of work runs in a **thread**: one work run with its own name,
    usually tied to a task. One bot can run many threads at once.
  - The full definitions are in the [glossary](docs/design/glossary.md).
  - A **harness** is the execution layer, not another bot. The Coordinator uses Mikka's AI SDK / Workflow harness for chat and tools; dispatched coding work uses the daemon's Claude Code, Codex or Cursor CLI harness. The retired standalone Agent chat is available only as read-only history.

- **One Coordinator, multiple execution harnesses.**
  - The Coordinator is a long-running bot. It wakes when a run ends, a task
    changes state, or a worker asks a question, decides the next step, and
    notifies you only when your input is required.
  - The Coordinator is the current built-in Bot. Its orchestration harness is
    separate from the CLI harnesses that execute dispatched coding threads.

- **Asks before it guesses.**
  - When a request is unclear, the Coordinator asks you for the missing details
    in chat before it dispatches a run.
  - While a run works, its agent can ask a question or report that it is
    blocked. The Coordinator puts the question to you with its options, never
    answers for you, and sends your answer back to the run.

- **Runs on your own machines.**
  - The Mikka daemon connects your Mac, Linux machine or server.
  - It starts work through the CLI harnesses you have already installed and signed in
    to, so your existing plans and settings apply.

- **Recovers from failures.**
  - Each run holds a lease. Periodic checkpoints preserve work in progress so
    an interrupted run can resume on another compatible online machine
    ([PR #201](https://github.com/alexj11324/Mikka/pull/201)).

- **Fits into your existing tools.**
  - Tasks sync both ways with Linear, other agents can operate Mikka through
    MCP, and a Telegram message can create a task.

### How a task moves

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/task-flow-dark.svg">
  <img src="docs/assets/task-flow-light.svg" alt="How a task moves through Mikka: a request is triaged, clarified with you in chat when unclear, and dispatched; the agent can ask you questions while it works; planned Factory stages add review, verification, release approval and monitoring.">
</picture>

The diagram shows the current task-and-thread flow: a finished run reports its
result in chat. The complete self-service path from connecting a device to
returning a GitHub PR is still being integrated and awaits live Preview
acceptance ([#357](https://github.com/alexj11324/Mikka/issues/357)).
The dashed loop is the planned Factory process: independent review and verification
([#193](https://github.com/alexj11324/Mikka/issues/193)), a fix run when a check fails, release approval by a person
([#194](https://github.com/alexj11324/Mikka/issues/194)), and monitoring that turns incidents into issues
([#195](https://github.com/alexj11324/Mikka/issues/195)). Systematic routing of ambiguous requests is tracked in
[#192](https://github.com/alexj11324/Mikka/issues/192).

## What Mikka does today

- **Turns requests into tasks.** The Coordinator breaks a request into tasks,
  dispatches runs, and decides whether each task belongs to the workspace or to
  you. You can change the assignment in one click.
- **Makes progress visible.** Every thread shows what its agent
  is doing. Workers report progress, ask questions and flag blocks through
  Mikka's MCP tools, and the Coordinator triages each one. A thread can also
  be stopped from its composer ([PR #336](https://github.com/alexj11324/Mikka/pull/336)).
- **Cites its sources.** Replies show the tasks, runs and web pages they draw
  on as chips you can open.
- **Keeps tasks in one place.** Tasks show on a board and a list, with
  relations, activity history and per-person task numbers. They sync both ways
  with Linear.
- **Filters notifications.** Mikka collects notifications from GitHub, Linear,
  Notion, Slack and Gmail, surfaces only those that need your attention, and
  writes a daily briefing.
- **Works from other tools.** Operate Mikka from Claude Code or Codex through its
  [MCP server](https://aspectlylabs.com/mikka/docs/mcp), or create tasks from
  Telegram.
- **Supports teams.** Workspaces, members, invitations and teams, with Google
  and GitHub sign-in.
- **Bilingual interface.** The app is available in English and Simplified Chinese.

## What we're building

Work in progress is tracked in
[GitHub issues](https://github.com/alexj11324/Mikka/issues), mirrored from
Linear (`MIK-xx`).

**Progress (October 28, 2026):** Thread stopping ([PR #336](https://github.com/alexj11324/Mikka/pull/336))
and checkpoint-based cross-machine handoff ([PR #201](https://github.com/alexj11324/Mikka/pull/201))
are merged. The local MVP integration PRs ([#358](https://github.com/alexj11324/Mikka/pull/358)–[#362](https://github.com/alexj11324/Mikka/pull/362))
remain open; the full device-to-PR flow has not completed fixed-Preview
acceptance ([#357](https://github.com/alexj11324/Mikka/issues/357)).

| Area | Planned | Tracking |
| --- | --- | --- |
| **Local device-to-PR MVP** | Finish self-service device setup, Coordinator issue tools, local Claude Code/Codex execution, approved GitHub PR delivery and real Preview acceptance. | [#357](https://github.com/alexj11324/Mikka/issues/357), [PRs #358–#362](https://github.com/alexj11324/Mikka/pull/362) |
| **Cloud computer** | Each bot gets its own desktop, which you can watch live, take control of, and hand back. It sleeps when idle and keeps its disk. Your own machines can also be connected. The updated plan uses a shared cloud machine for Bot desktops and browser sub-agents, with a separate machine for each cloud coding thread. | [#172](https://github.com/alexj11324/Mikka/issues/172), [#342](https://github.com/alexj11324/Mikka/issues/342), [#147](https://github.com/alexj11324/Mikka/issues/147) |
| **Approvals in chat** | When an agent needs authorization, you respond in the chat: allow once, deny, or allow for the rest of the task. | [#147](https://github.com/alexj11324/Mikka/issues/147), [#177](https://github.com/alexj11324/Mikka/issues/177) |
| **Group chats** | Multiple bots and people in one chat, with turn-taking, @ mentions and a status bar showing who is working. | [#105](https://github.com/alexj11324/Mikka/issues/105) |
| **Factory** | An end-to-end delivery process: one run per task at a time, durable stage state, independent review and verification threads, and human release approval based on recorded evidence. | [#191](https://github.com/alexj11324/Mikka/issues/191)–[#195](https://github.com/alexj11324/Mikka/issues/195) |
| **Cross-machine handoff** | **Merged:** Save work in progress and resume interrupted runs on another compatible online machine. | [PR #201](https://github.com/alexj11324/Mikka/pull/201) |
| **Scheduled tasks** | Bots run tasks at a set time or on a recurring schedule and report the results in chat. | [#179](https://github.com/alexj11324/Mikka/issues/179) |
| **Connected apps** | Workflows for mail, calendar, documents and Slack that can take actions, not only read, subject to your approval. | [#177](https://github.com/alexj11324/Mikka/issues/177) |
| **Secure credentials** | Agents request credentials through a secure form. A vault holds them, and a controlled browser uses them only for approved actions. | [#180](https://github.com/alexj11324/Mikka/issues/180) |
| **Usability** | Onboarding, ⌘K search, a knowledge base, web search for agents, and team visibility settings. | [#129](https://github.com/alexj11324/Mikka/issues/129), [#131](https://github.com/alexj11324/Mikka/issues/131), [#134](https://github.com/alexj11324/Mikka/issues/134), [#100](https://github.com/alexj11324/Mikka/issues/100), [#127](https://github.com/alexj11324/Mikka/issues/127) |

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
  <img src="docs/assets/architecture-light.svg" alt="Mikka architecture: clients reach the Next.js app on Vercel, the Coordinator dispatches runs to the daemon on your machine, agents report back through MCP, and state lives in Postgres and syncs with Linear.">
</picture>

The web app, Telegram and MCP clients all reach the same Next.js application on
Vercel. Events such as a finished run or a worker question go to the
Coordinator, a durable workflow that triages each event and decides the next
step.

Runs execute on your machines. The daemon registers the device, claims runs
through the device API, and starts the agent CLI in a dedicated git worktree.
The agent reports progress, questions and blocks through Mikka's MCP worker
tools.

Linear sync runs in a Cloudflare Worker that exchanges changes with Postgres
through a durable inbox and outbox.

Dashed boxes and lines are on the roadmap: the Scheduler
([#179](https://github.com/alexj11324/Mikka/issues/179)), Factory stages ([#191](https://github.com/alexj11324/Mikka/issues/191)–[#194](https://github.com/alexj11324/Mikka/issues/194)), Monitoring
([#195](https://github.com/alexj11324/Mikka/issues/195)), the cloud computer ([#172](https://github.com/alexj11324/Mikka/issues/172)), local computer use ([#147](https://github.com/alexj11324/Mikka/issues/147)), connected-app actions
([#177](https://github.com/alexj11324/Mikka/issues/177)) and the credential vault ([#180](https://github.com/alexj11324/Mikka/issues/180)).
Checkpoint-based handoff between compatible machines is already merged
([PR #201](https://github.com/alexj11324/Mikka/pull/201)).

## Built with

| Layer | Stack |
| --- | --- |
| App | Next.js 16, React 19, Tailwind CSS 4, shadcn/ui, ReUI |
| Bots | Vercel AI SDK; the Coordinator is a durable loop on [Vercel Workflow](workflows/coordinator) |
| Triage | Rules first, then a model call through Vercel AI Gateway with a monthly cost cap |
| Data | Postgres on Neon, Drizzle migrations in [`drizzle/`](drizzle) |
| Auth | Better Auth, with Google and GitHub sign-in and an OAuth 2.1 server for MCP |
| Integrations | GitHub and Linear webhooks; Composio for Gmail, Google Calendar, Notion and Slack; a Cloudflare Worker for Linear sync; Vercel Chat SDK for Telegram |
| Execution harnesses | The Mikka daemon selects a Claude Code, Codex or Cursor CLI adapter for each work thread |

## Repository layout

```text
app/                 # Next.js routes, server actions and API (MCP, webhooks, daemon /v1)
components/          # React UI
lib/                 # Domain logic: coordinator, issues, Linear sync, MCP, auth
workflows/           # Durable workflows (the Coordinator)
packages/daemon/     # Local daemon and CLI execution harness adapters
packages/protocol/   # Types shared by the server and the daemon
packages/config/     # Shared configuration
cloudflare/          # Cloudflare Worker for Linear sync
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
