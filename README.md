<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/brand/mikka-icon-dark.svg">
  <img src="public/brand/mikka-icon-light.svg" alt="Mikka" width="72">
</picture>

# Mikka

### The AI lead for ambitious work.

为大事而生的 AI lead：从本地到云端，所有 Agent 协作如一。

Mikka runs the coding agents you already use as one team. Tell a bot what you
need in plain words. It turns the ask into tasks and hands each one to Claude
Code, Codex or Cursor, on your own machine today and on a cloud computer soon.

You follow every piece of work as it happens, step in when it needs you, and
review what comes back.

**Open Mikka:** [app.aspectlylabs.com/mikka](https://app.aspectlylabs.com/mikka)
· **Docs:** [aspectlylabs.com/mikka/docs](https://aspectlylabs.com/mikka/docs)
· **Quickstart:** [aspectlylabs.com/mikka/docs/quickstart](https://aspectlylabs.com/mikka/docs/quickstart)

## How Mikka works

- **Bots talk. Threads work.**
  - A bot chats with you, plans the work and hands it out. It does not do the
    work itself.
  - Each piece of work runs in a **thread**: one agent run with its own name,
    usually tied to a task. One bot can run many threads at once.
  - The full definitions are in the [glossary](docs/design/glossary.md).

- **One lead, many agents.**
  - The Coordinator is a long-running bot. It wakes up when a run ends, a task
    moves, or a worker asks a question, decides what happens next, and tells
    you only when it needs you.
  - Create more bots for different kinds of work, or put several in a group
    chat and let them split it.

- **Your machines, your agents.**
  - The Mikka daemon connects your Mac, Linux machine or server.
  - It runs agents through the CLIs you already installed and signed in to, so
    your own plans and settings apply.

- **Work that survives failure.**
  - Each run holds a lease. If a machine goes offline mid-run, Mikka retries
    the run in the same worktree and session instead of starting over.

- **Meets you where you already work.**
  - Tasks sync both ways with Linear. Other agents drive Mikka through MCP.
    Telegram turns a message into a task.

## What Mikka does today

- **Turns asks into tasks.** The Coordinator breaks a request into tasks,
  dispatches runs, and decides whether each task belongs to the workspace or to
  you. You can change it in one click.
- **Shows the work, not just the result.** Every thread shows what its agent
  is doing. Workers report progress, ask questions and flag blocks through
  Mikka's MCP tools, and the Coordinator triages each one.
- **Cites its sources.** Replies show the tasks, runs and web pages they draw
  on as chips you can open.
- **Keeps tasks in one place.** Tasks show on a board and a list, with
  relations, activity history and per-person task numbers. They sync both ways
  with Linear.
- **Catches what matters.** Mikka reads notifications from GitHub, Linear,
  Notion, Slack and Gmail, keeps only the ones worth your time, and writes a
  short daily briefing.
- **Works from other tools.** Drive Mikka from Claude Code or Codex through its
  [MCP server](https://aspectlylabs.com/mikka/docs/mcp), or create tasks from
  Telegram.
- **Runs as a team.** Workspaces, members, invitations and teams, with Google
  and GitHub sign-in.
- **Speaks your language.** The app ships in English and Simplified Chinese.

## What we're building

Work in progress is tracked in
[GitHub issues](https://github.com/alexj11324/Mikka/issues), mirrored from
Linear (`MIK-xx`).

| Area | What's coming | Tracking |
| --- | --- | --- |
| **Cloud computer** | Every bot gets its own desktop. Watch it live, take control, hand it back. It sleeps when idle and keeps its disk. You can also bring your own machine. | [#172](https://github.com/alexj11324/Mikka/issues/172), [#147](https://github.com/alexj11324/Mikka/issues/147) |
| **Approvals in chat** | When an agent needs your OK, approve it in the chat: once, never, or for the rest of the task. | [#147](https://github.com/alexj11324/Mikka/issues/147), [#177](https://github.com/alexj11324/Mikka/issues/177) |
| **Group chats** | Several bots and people in one chat, with turn-taking, @ mentions and a "who is working" bar. | [#105](https://github.com/alexj11324/Mikka/issues/105) |
| **Factory** | A full delivery loop: one run per task at a time, durable stages, independent review and verification threads, and a human release gate backed by real evidence. | [#191](https://github.com/alexj11324/Mikka/issues/191)–[#195](https://github.com/alexj11324/Mikka/issues/195) |
| **Hand-off between machines** | Save work in progress and move a lost run to another machine. | [PR #201](https://github.com/alexj11324/Mikka/pull/201) |
| **Scheduled tasks** | Ask a bot to do something later or on a schedule, and get the result back in chat. | [#179](https://github.com/alexj11324/Mikka/issues/179) |
| **Connected apps** | Mail, calendar, docs and Slack workflows that act, not just read, with approval. | [#177](https://github.com/alexj11324/Mikka/issues/177) |
| **Everyday polish** | Onboarding, ⌘K search, a knowledge base, web search for agents, and team visibility rules. | [#129](https://github.com/alexj11324/Mikka/issues/129), [#131](https://github.com/alexj11324/Mikka/issues/131), [#134](https://github.com/alexj11324/Mikka/issues/134), [#100](https://github.com/alexj11324/Mikka/issues/100), [#127](https://github.com/alexj11324/Mikka/issues/127) |

## Connect your agents

### Drive Mikka over MCP

Mikka is an MCP server (Streamable HTTP, OAuth 2.1). Add it to Claude Code:

```sh
claude mcp add --transport http mikka https://app.aspectlylabs.com/mikka/api/mcp
```

Claude Code signs you in through your browser. Agents can then read and change
tasks, dispatch runs and update the Coordinator's memory. Other clients and the
full tool list are in the [MCP docs](https://aspectlylabs.com/mikka/docs/mcp).

### Run agents on your own machine

The daemon in [`packages/daemon`](packages/daemon) detects the agent CLIs on
the machine and runs threads through them:

| Agent | CLI it looks for |
| --- | --- |
| Claude Code | `claude` |
| Codex | `codex` |
| Cursor | `cursor-agent` or `agent` |

Each run gets its own git worktree, so parallel threads do not step on each
other.

## Built with

| Layer | Stack |
| --- | --- |
| App | Next.js 16, React 19, Tailwind CSS 4, shadcn/ui, ReUI |
| Bots | Vercel AI SDK; the Coordinator is a durable loop on [Vercel Workflow](workflows/coordinator) |
| Triage | Rules first, then a model call through Vercel AI Gateway with a monthly cost cap |
| Data | Postgres on Neon, Drizzle migrations in [`drizzle/`](drizzle) |
| Auth | Better Auth, with Google and GitHub sign-in and an OAuth 2.1 server for MCP |
| Integrations | GitHub and Linear webhooks; Composio for Gmail, Notion and Slack; a Cloudflare Worker for Linear sync; Vercel Chat SDK for Telegram |
| Agents | The Mikka daemon, with adapters for Claude Code, Codex and Cursor |

## Repository layout

```text
app/                 # Next.js routes, server actions and API (MCP, webhooks, daemon /v1)
components/          # React UI
lib/                 # Domain logic: coordinator, issues, Linear sync, MCP, auth
workflows/           # Durable workflows (the Coordinator)
packages/daemon/     # Local daemon that runs agents through your own CLIs
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
put them in a local `.env`.

Install dependencies and run the source-only checks:

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
- [`docs/review-checklist.md`](docs/review-checklist.md): run before showing UI
  to anyone.

## Get access

Mikka is in early access. Email
[hello@aspectlylabs.com](mailto:hello@aspectlylabs.com) for an invite, then
follow the [Quickstart](https://aspectlylabs.com/mikka/docs/quickstart).
