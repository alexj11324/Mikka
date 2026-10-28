<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/brand/mikka-icon-dark.svg">
  <img src="public/brand/mikka-icon-light.svg" alt="Mikka" width="112">
</picture>

# Mikka

### From request to result.

Tell Mikka the goal. Agents and devices collaborate behind the scenes.

[![UI policy](https://github.com/alexj11324/Mikka/actions/workflows/ui-policy.yml/badge.svg?branch=main)](https://github.com/alexj11324/Mikka/actions/workflows/ui-policy.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
[![LINUX DO](https://img.shields.io/badge/LINUX%20DO-Community-FFB003)](https://linux.do)

[Open Mikka](https://app.aspectlylabs.com/mikka) · [Docs](https://aspectlylabs.com/mikka/docs) · [Quickstart](https://aspectlylabs.com/mikka/docs/quickstart)

**English** · [简体中文](README.zh-CN.md)

</div>

Mikka is an open-source AI assistant for personal and professional work.
Describe the result you want, clarify requirements when necessary and review
what is delivered. Mikka coordinates tasks, agents and devices so you do not
have to micromanage separate agent sessions.

**Status:** Early access. Core conversations, tasks, integrations and local
execution infrastructure exist in the repository. The complete self-service
request-to-PR workflow is still being integrated ([#357](https://github.com/alexj11324/Mikka/issues/357));
cloud computers and everyday browser-based assistance are in development.

## From request to result

You describe **what** you want to achieve. Mikka takes care of **how** the work is organized and carried through, instead of asking you to manage a collection of AI sessions.

1. **Describe the outcome.** Talk to a Bot, including the built-in Coordinator. It can clarify missing requirements before work starts.
2. **Delegate the work.** Mikka represents work as tasks (issues). For coding, a Bot dispatches a **thread** to an execution harness on a connected device.
3. **Intervene when needed.** Threads report progress, questions and blockers. You can inspect them, reply and stop a run; approvals remain under your control.
4. **Review what was delivered.** Results and artifacts return to Mikka. The complete repository push → GitHub PR → chat handoff path is still being integrated under [#357](https://github.com/alexj11324/Mikka/issues/357).

### The product model

| Concept | Meaning |
| --- | --- |
| **Bot** | The assistant you chat with. The Coordinator is the built-in Bot. Browser-based web work through a Bot's isolated sub-agents is under development. |
| **Chat** | Your conversation with a Bot or a group; it has no separate task identity. |
| **Task / issue** | A unit of work, personal or workspace-scoped, that may have multiple threads over time. |
| **Thread** | One named work run dispatched by a Bot, usually for a coding task. It is not another Bot. |
| **Device** | The local or remote machine that executes a thread. Managed Mikka Cloud computers are planned. |
| **Harness** | The execution engine: Mikka's AI SDK / Workflow for Bot conversation and orchestration, and CLI coding agents for dispatched threads. |

This follows the [product glossary](docs/design/glossary.md). The old standalone Agent chat runtime is retired; its historical conversations remain read-only.

### Task flow

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/task-flow-dark.svg">
  <img src="docs/assets/task-flow-light.svg" alt="Proposed request-to-result flow: clarification, task dispatch, execution, review, verification and release. The later Factory stages are planned.">
</picture>

This diagram describes the intended delivery process, **not a claim that every stage is available**. The stop control ([#336](https://github.com/alexj11324/Mikka/pull/336)) and checkpoint-based cross-device handoff ([#201](https://github.com/alexj11324/Mikka/pull/201)) are merged. The remaining self-service device onboarding, issue-tool, local-runtime, PR-publication and end-to-end acceptance work is tracked in [#357](https://github.com/alexj11324/Mikka/issues/357). Independent review, verification, release approval and monitoring remain planned ([#191](https://github.com/alexj11324/Mikka/issues/191)–[#195](https://github.com/alexj11324/Mikka/issues/195)).

## Available on main

- **Coordinator and Bot conversations.** Event-driven coordination, clarification, source citations and follow-up messages.
- **Task management.** Board and list views, task relations and activity, personal/workspace scoping, and two-way Linear synchronization.
- **Coding execution infrastructure.** A daemon for connected machines, isolated git worktrees, thread progress and questions, stop controls, leases and periodic checkpoints. Interrupted runs can be handed to a compatible online device; this is not a guarantee that every external side effect is replay-safe.
- **Integrations.** An OAuth 2.1 / Streamable HTTP [MCP server](docs/mcp.md), worker tools for reporting and artifacts, GitHub and Linear integration, Telegram, and connected-app hooks where configured.
- **Access and interface.** Google and GitHub login, English and Simplified Chinese, and existing workspace collaboration primitives.

These are repository capabilities, not a guarantee of a fully deployed self-service onboarding experience. Features behind configuration, rollout flags or unfinished integrations may not be available to every early-access user.

## In progress

| Focus | Direction | Tracking |
| --- | --- | --- |
| **Complete local MVP** | Connect a device, create a task from chat, run Claude Code or Codex, and return a verified result with an approved PR. | [#357](https://github.com/alexj11324/Mikka/issues/357) |
| **Cloud execution and web tasks** | E2B-powered infrastructure: shared Bot desktops and isolated browser sub-agents, with a separate machine for each cloud coding thread. | [#172](https://github.com/alexj11324/Mikka/issues/172), [#342](https://github.com/alexj11324/Mikka/issues/342) |
| **Proactive personal help** | Prioritized connected-app events, personal memory, contextual suggestions and recurring work. | [Design](docs/design/proactive.md), [#179](https://github.com/alexj11324/Mikka/issues/179) |
| **Delivery verification** | Automated review and test loops, recorded evidence and human approval for release. | [#191](https://github.com/alexj11324/Mikka/issues/191)–[#195](https://github.com/alexj11324/Mikka/issues/195) |
| **Approved external actions** | Connected-app writes with explicit authorization and an account-scoped credential vault. | [#177](https://github.com/alexj11324/Mikka/issues/177), [#180](https://github.com/alexj11324/Mikka/issues/180) |
| **Mobile** | Native iOS-first app built with Expo / React Native. | [`apps/mobile`](apps/mobile) |

Development is tracked in [GitHub issues](https://github.com/alexj11324/Mikka/issues). Enterprise-specific expansion is paused while the personal assistant and end-to-end delivery loop take priority.

## Connect coding agents

### Operate Mikka through MCP

Mikka is an MCP server (Streamable HTTP, OAuth 2.1). Add it to Claude Code:

```sh
claude mcp add --transport http mikka https://app.aspectlylabs.com/mikka/api/mcp
```

Claude Code completes sign-in in your browser. Agents can then read and modify
tasks, dispatch runs and update the Coordinator's memory. Other clients and the
full tool list are in the [MCP docs](https://aspectlylabs.com/mikka/docs/mcp).

### Run coding harnesses on your own machine

The daemon in [`packages/daemon`](packages/daemon) detects installed coding CLIs
and can execute threads through them. Self-service device authorization and
packaging are part of the [local MVP work](https://github.com/alexj11324/Mikka/issues/357):

| Execution harness | CLI it looks for |
| --- | --- |
| Claude Code | `claude` |
| Codex | `codex` |
| Cursor | `cursor-agent` or `agent` |

Each run uses an isolated git worktree. You can use an existing signed-in CLI;
Mikka does not require a separate user-managed model-provider dashboard.

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture-dark.svg">
  <img src="docs/assets/architecture-light.svg" alt="Mikka architecture: clients reach the Next.js app on Vercel, the Coordinator dispatches runs to the daemon on your machine, agents report back through MCP, and state lives in Postgres and syncs with Linear.">
</picture>

The web app, Telegram and MCP clients all reach the same Next.js application on
Vercel. Events such as a finished run or a worker question go to the
Coordinator, a durable workflow that triages each event and decides the next
step.

Runs execute on connected devices. The daemon registers a device, claims runs
through the device API, and starts a CLI in a dedicated git worktree. The agent
reports progress, questions and blocks through Mikka's MCP worker tools.
Run leases and checkpoints support recovery on a compatible online device;
managed cloud computers and browser sub-agents are not generally available yet.

Linear sync runs in a Cloudflare Worker that exchanges changes with Postgres
through a durable inbox and outbox.

Some dashed portions of the diagram remain planned: scheduling ([#179](https://github.com/alexj11324/Mikka/issues/179)), Factory review and release stages ([#191](https://github.com/alexj11324/Mikka/issues/191)–[#195](https://github.com/alexj11324/Mikka/issues/195)), managed cloud computers ([#172](https://github.com/alexj11324/Mikka/issues/172)), browser computer use ([#147](https://github.com/alexj11324/Mikka/issues/147)), and approved connected-app actions and credentials ([#177](https://github.com/alexj11324/Mikka/issues/177), [#180](https://github.com/alexj11324/Mikka/issues/180)). Cross-device handoff ([#201](https://github.com/alexj11324/Mikka/pull/201)) has already merged.

## Built with

| Layer | Stack |
| --- | --- |
| App | Next.js 16, React 19, Tailwind CSS 4, shadcn/ui, ReUI |
| Bots | Vercel AI SDK; the Coordinator is a durable loop on [Vercel Workflow](workflows/coordinator) |
| Triage | Rules first, then a model call through Vercel AI Gateway with a monthly cost cap |
| Data | Postgres on Neon, Drizzle migrations in [`drizzle/`](drizzle) |
| Auth | Better Auth, with Google and GitHub sign-in and an OAuth 2.1 server for MCP |
| Integrations | GitHub and Linear webhooks; Composio for Gmail, Google Calendar, Notion and Slack; a Cloudflare Worker for Linear sync; Vercel Chat SDK for Telegram |
| Execution harnesses | The Mikka daemon detects Claude Code, Codex and the existing Cursor CLI adapter for coding threads |
| Mobile (in development) | Expo / React Native; iOS first, in [`apps/mobile`](apps/mobile) |

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
