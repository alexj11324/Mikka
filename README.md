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
Each bot also has a cloud desktop you can watch, take over and hand back.

Track progress, respond when needed and review results in one place, on the web,
in the macOS desktop app or in the iOS app.

## Run your own server

Deploy the [self-hosted Docker server](docs/self-hosting.md), then connect the
official app to its address. The image provides the API, realtime updates,
daemon gateway, scheduler, migrations and your own model credentials. Its
default web entry exposes server information and keeps the authentication
pages needed by the official clients.

Mikka has one UI: the official web, desktop and iOS apps, which connect to
Mikka Cloud or to your server. An older built-in workspace UI is still in the
source and off by default (`MIKKA_COMMUNITY_UI=1` turns it on); it is not a
second design. Paid UI component source is not distributed in this repository
or image.

## Product and source boundaries

This repository contains the backend, the native mobile client and most of the
UI's web code. Official web and desktop builds also bring in the private
`mikka-hosted-ui` through [UI slots](docs/ui-overlay.md); the build without it
only has to compile ([one UI](docs/design/decisions/2026-11-08-2133-one-ui.md)). The capability summary describes these
source paths. Release and external-service results are recorded through
[runtime acceptance](docs/acceptance.md).

The accepted interface lists tasks and opens their work inside each task, with
one conversation joining a task's runs. The native mobile source implements
this model. The default slots in this repository still show thread lists and separate
run views; what ships is the official build, which needs its own version-bound release evidence.
See the [task navigation decision](docs/design/decisions/2026-11-07-2045-tasks-only-threads-inside.md)
and [task conversation decision](docs/design/decisions/2026-11-07-2300-one-conversation-per-task.md).

## How Mikka works

- **Bots coordinate. Agents execute.**
  - A bot chats with you, plans the work and dispatches coding tasks to
    Agents on your computers.
  - Coding work is attached to a **task**. A **thread** is a chain of runs
    that resume, retry or continue that work. A bot can dispatch work on
    several tasks at once.
  - The full definitions are in the [glossary](docs/design/glossary.md).
  - An **Agent** is the worker that does a thread's work: Claude Code, Codex or Cursor, running on a **computer** (yours, an SSH server, or Mikka Cloud). Bots are not Agents: every bot chats on Mikka's AI SDK / Workflow loop, the Coordinator's. The retired standalone Agent chat is available only as read-only history. Running the Coordinator itself on Claude Code or Codex ([#312](docs/architecture/native-coordinator.md)) is a deprecated design: the code is kept switched off and must not be enabled.

- **The Coordinator and your own bots.**
  - The Coordinator is the built-in bot. It is long-running: it wakes when a
    run ends, a task changes state, or a worker asks a question, decides the
    next step, and asks for your input when needed. A Decision model judges
    when connected-app matters should interrupt you, within runaway budgets.
  - You can create more bots, each with its own name, shape and colour. Every
    bot chats on the same loop as the Coordinator, with its own chat, memory
    and dispatched tasks, and hands coding work to Agents.

- **Asks before it guesses.**
  - Before it dispatches, the Coordinator routes an unclear request back to
    you, in chat or as a choice card.
  - A worker can ask a question or report that it is blocked. The thread waits
    for your reply, and your answer goes back to the run.

- **Runs on your own machines.**
  - The Mikka daemon connects your Mac, Linux machine or server. The desktop
    app can also install it on a server over SSH.
  - It installs its own pinned Claude Code and Codex when needed and runs
    work with the selected subscription or model credentials.

- **Recovers from failures.**
  - Runs use leases and repository checkpoints. Eligible runs can retry on
    another online device with the required Agent and access to the repository.

- **Fits into your existing tools.**
  - Other agents can operate Mikka through MCP, and a Telegram message or a
    Slack mention reaches the Coordinator. Two-way Linear sync is built but
    switched off.

### How a task moves

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/task-flow-dark.svg">
  <img src="docs/assets/task-flow-light.svg" alt="How a task moves through Mikka: a request from chat, Telegram, Slack or MCP is triaged; an unclear one goes back to the person for details, a clear one is dispatched to an Agent. The Agent can ask for clarification and gets the answer back. A finished run receives independent review and required checks, including separate verification when its recorded contract requires it. Failed checks return to a fix run, followed by acceptance and release. Monitoring can open follow-up issues.">
</picture>

Factory routes a task through the stages it needs, including triage, plan,
implementation and review. A failed check sends it back for a fix, and monitoring
can open follow-up issues. For an eligible code candidate, accepting the work on
its acceptance page merges the pull request through your connected GitHub
account. Publication depends on the configured target and deployment switches.

## Product capabilities

- **Turns requests into tasks and runs.** The Coordinator creates and updates
  numbered tasks in the selected workspace, then dispatches their work to Agents.
- **Names tasks briefly.** A small model writes a short title after a task
  is created. A title you change yourself wins.
- **Lets you create bots.** The left column lists the Coordinator and the bots
  you create. Each bot has its own chat, with unread markers and an animated
  avatar.
- **Makes progress visible.** Dispatch cards link to the work and its status.
  The accepted task interface opens the task and joins its runs in one
  conversation. Workers report progress, ask questions and flag blocks through
  Mikka's MCP tools. You can reply to or stop your own work.
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
- **Delivers through Factory.** Triage and clarification, review, a fix run
  when a check fails, run captures as evidence, an acceptance page that merges
  the pull request as you, and monitoring that opens a follow-up issue.
- **Acts in your apps.** Bots propose email, Google Calendar, Notion and Slack
  actions under your connection permissions and applicable approval policy.
- **Keeps tasks in one place.** Tasks show on a board and a list, with
  relations, activity history and a number every task gets when it is
  created: its team key for a workspace task (AL-12), your own prefix for a
  personal one (ALEX-12). The task's branch and pull request carry it. ⌘K
  searches bots, group chats, tasks and projects. The default slots in this
  repository also expose retained thread results.
- **Decides what needs you.** Mikka rates notifications from GitHub, Linear,
  Notion and Gmail by what it costs to ignore them. The Coordinator and
  Decision model judge urgency and interruption timing. Other matters wait in
  Suggestions. Eligible daily briefings arrive after 08:00 in your time zone,
  with empty briefings omitted.
- **Gets you started.** A first-run guide has you create your first bot and
  connect a subscription. You can replay it from Settings › Preferences.
- **Uses your own subscriptions and keys.** Connect a ChatGPT (Codex) or Claude
  subscription, or add a model provider's API key, in Settings › Models and
  subscriptions. Supported subscriptions answer bot chats and run coding tasks
  on local or cloud machines. Native coding CLIs use the selected subscription
  or API credential and connect directly to the provider.
- **Plugins.** The plugin store lists apps and searches public agent skills.
  Settings › Connections lists connected apps and custom MCP servers, including
  owner-controlled workspace sharing. Installed skills have API management
  and are included in Coordinator instructions. Connections retain their owner
  and workspace access rules.
- **Group chats.** Web and mobile clients let you create a group of your bots,
  send messages with @ mentions and read their replies. The backend judges
  which bots should contribute when a message names none.
- **Settings inside the app.** Settings open in the app window, with sections
  for account, security, preferences, notifications, memory, connections,
  models, saved logins, privacy and devices, and for workspace admins general,
  members, teams, permissions, secrets, audit log, usage and billing.
- **Billing.** The hosted model (Mikka 默认) includes a capped 20-message trial
  per workspace creator, shared across all workspaces they create. Card
  verification uses Stripe Checkout and grants a one-off $1 allowance to the
  person's personal workspace, once per card. Purchased workspace credits also fund hosted usage. Top-ups use Stripe
  Checkout. Your own subscriptions, devices and E2B key need no card.
- **Manages devices.** Settings › Devices lists your computers. Removing an
  online device also uninstalls its daemon.
- **Works from other tools.** Operate Mikka from Claude Code or Codex through its
  [MCP server](https://aspectlylabs.com/mikka/docs/mcp), or reach the
  Coordinator from Telegram or Slack.
- **Supports teams.** Workspaces, members, invitations and teams, with email,
  Google and GitHub sign-in when their providers are configured. Email sign-in
  has a separate kill switch.
- **Desktop app.** A macOS app for Apple Silicon renders the same UI in a
  translucent window, signs in through the system browser, shows waiting runs
  in the Dock and system notifications, and updates itself from GitHub
  Releases. It also enrolls servers from your `~/.ssh/config` over SSH. Its
  icon is a layered Liquid Glass icon with default, dark, tinted and clear
  looks on macOS 26.
- **iOS app.** Built in [`apps/mobile`](apps/mobile) with native Bot, Tasks,
  Suggestions, Settings and Search tabs, task conversations and push
  notifications. Native release and OTA delivery use the mobile workflows.
- **Cloud computer.** Each bot gets its own desktop on Mikka Cloud. Direct
  E2B computers use their owner's personal key. The 电脑 tab lets you watch it
  live, take control and hand it back. Desktop automation pauses while you hold it, and it sleeps when
  idle and keeps its disk. Bots can start web sub-agents there, each in its own browser, and
  desktop actions follow the applicable authorization policy. Coding tasks
  follow the selected execution location, and each cloud task keeps a separate
  sandbox, paused between its runs.
- **Saved logins.** A web sub-agent can request a secure login card. The
  credential broker fills saved credentials into the bound browser page.
  Cloud storage uses AWS KMS envelope encryption. You can delete saved logins
  in Settings.
- **Scheduled tasks.** Bots can create reminders, task snapshots and read-only
  agent tasks that run at a set time or on a schedule.
- **Bilingual interface.** Web and desktop support English and Simplified Chinese.
  The native mobile source uses Simplified Chinese labels.

Behind a switch that is off by default:

- **Memory of you.** With both deployment and personal profile flags enabled,
  Mikka extracts facts from rated notifications, merges them once per local day
  from 04:00, and shows them in Memory for you to correct or delete.

## What we're building

The Coordinator's event triage uses a vision-capable Decision model for
business meaning, with actual image inputs when supplied. Your messages take
the direct attention path. Triage preserves existing allow / ask / deny
policies and does not grant new authority. See the
[implementation and acceptance rules](docs/acceptance.md).

Work in progress is tracked in
[GitHub issues](https://github.com/alexj11324/Mikka/issues).

| Area | Planned | Tracking |
| --- | --- | --- |
| **Cloud computer** | Mikka-billed compute. Its points UI is gated by `mikka-computer-billing`, whose source default is off. The direct E2B path uses the run owner's personal key. | [#172](https://github.com/alexj11324/Mikka/issues/172) |
| **Hybrid execution** | Agents on your computer offload builds, tests and dev servers to Mikka Cloud. | [#572](https://github.com/alexj11324/Mikka/issues/572) |
| **Plugins** | Further installed-skill and workspace-admin controls. Custom MCP listing and workspace-sharing controls already exist in Settings › Connections. | [#595](https://github.com/alexj11324/Mikka/issues/595) |
| **Proactive suggestions** | A nightly research run that turns your deadlines and interests into a few suggestion cards a day, which start a task when tapped. | [#350](https://github.com/alexj11324/Mikka/issues/350) |

## Connect your agents

### Operate Mikka through MCP

Mikka is an MCP server (Streamable HTTP, OAuth 2.1). Add it to Claude Code:

```sh
claude mcp add --transport http mikka https://app.aspectlylabs.com/mikka/api/mcp
```

Claude Code completes sign-in in your browser. Agents can then read and modify
tasks, dispatch runs and update the Coordinator's memory. Other clients and the
full tool list are in the [MCP docs](https://aspectlylabs.com/mikka/docs/mcp).

### Where Agents run: Mikka managed cloud, or your own

Like hosted and self-hosted CI runners, an Agent runs either on a machine Mikka
manages or on one you bring.

**Mikka managed cloud.** On Mikka Cloud, Mikka starts the machine, sleeps it when idle and
keeps its disk. Cloud access is configured for the run owner. The direct E2B
runtime uses that person's own key. Follow the account or cloud connection
setup offered by your server. The separate cloud-compute points UI is gated by
`mikka-computer-billing`.

**Your own.** Your computer, through the desktop app or the daemon, or any
server you reach over SSH. Mikka installs the daemon there and dispatches
Agents to it. The daemon in [`packages/daemon`](packages/daemon) reports its
managed runtimes and installs supported Claude Code and Codex versions on
first use.

| Agent | Local runtime |
| --- | --- |
| Claude Code | Daemon-managed pinned `claude` |
| Codex | Daemon-managed pinned `codex` |
| Cursor | `cursor-agent` or `agent`, on runners that report Cursor support |

Parallel coding work uses isolated git worktrees. Continuations can reuse
the same worktree.

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/architecture-dark.svg">
  <img src="docs/assets/architecture-light.svg" alt="Mikka architecture: the web, desktop and iOS apps, Telegram, Slack, notification sources and MCP clients reach the Hono/Nitro API on Vercel, which keeps state in Postgres and takes payments through Stripe. Durable due timers, maintenance work and app events wake the Coordinator, which dispatches runs to the daemon on your Mac, Linux machine or SSH host and wakes each bot's Mikka Cloud computer. Agents report back through MCP. Factory stages fed by monitoring sit on top of the Coordinator, and approved writes go back to connected apps. Linear sync, switched off, is dashed.">
</picture>

The web app, the desktop and iOS apps, Telegram, Slack and MCP clients all reach
the same Hono/Nitro API on Vercel. The web and desktop share the Vite-built React
UI. Events such as a finished run, a worker
question or a rated notification go to the Coordinator, a durable workflow
that triages each event and decides the next step. Every bot runs on the same
workflow, each with its own chat, memory and inbox.

The configured Cloudflare device gateway carries live invalidations and device
push over WebSockets. Self-hosted Node deployments can use the built-in gateway.
The gateway configuration selects the transport for that installation.

Coding runs execute on local devices, SSH servers or task-specific cloud
machines. The daemon claims a run and starts the selected Agent CLI in a
dedicated worktree. The run freezes its model, credential source and execution
choice from the task and workspace preferences. Device participation controls
apply to scheduling ([execution settings](docs/execution-rules.md)). Eligible
lost-device runs can retry from repository checkpoints on a compatible online
device. Agents report progress, questions and blocks through MCP worker tools.

Each bot has its own desktop display on an owner/workspace E2B bot machine,
viewable through noVNC. Coding tasks use separate task machines, with one VM
per task and pause/resume between runs. A Go subscription worker in
[`packages/subscription-worker`](packages/subscription-worker) holds connected
subscription credentials in Infisical. Native Claude Code and Codex receive
their selected run authentication and use ordinary HOME, Git and direct
provider connections. Authorized GitHub credentials are prepared for native
repository operations.

Third-party task Secrets use the separate delivery policy in
[`lib/secrets`](lib/secrets). The source separates ordinary environment values,
explicitly approved direct exposure and protected HTTP capabilities bound to a
run. Missing protected HTTP configuration is reported as unavailable. Deployed
protection requires version-bound canary and runtime evidence under the
[credential exposure decision](docs/design/decisions/2026-11-08-0240-credential-exposure-boundary.md).
Saved website logins use the separate
[`credential broker`](services/credential-broker) and AWS KMS path.

The hosted default model (Mikka 默认) is called on ZeroCat's OpenAI-compatible
API, with Vercel AI Gateway as its fallback, and is metered per call; card
verification and top-ups go through Stripe Checkout and its webhooks.

Coordinator wakes, schedules, run recovery, account deletion and audit
retention use durable due timers armed by state changes. The Cloudflare
maintenance Worker ticks every minute but sends requests only when work is
due. Reconciliation, operational monitoring and briefing checks run every
15 minutes. Subscription cleanup and notification reconciliation run hourly,
and the hourly profile check claims each eligible person's daily merge from
04:00 local time. See [scheduling and maintenance](docs/suggestions-cron.md).
Linear sync uses another Worker with a durable Postgres inbox and outbox. It
remains disabled by the accepted rollout policy and its PostHog flag.

The dashed box and lines are Linear sync, which is switched off.

## Built with

| Layer | Stack |
| --- | --- |
| App | Vite, Hono/Nitro, React 19, Tailwind CSS 4, shadcn/ui, ReUI, OpenUI for bot replies |
| Desktop | Electron with electron-updater in [`apps/desktop`](apps/desktop) (macOS, Apple Silicon) |
| Mobile | Expo and Expo Router (React Native) with native tabs in [`apps/mobile`](apps/mobile) |
| Bots | Vercel AI SDK; the hosted default model on ZeroCat, with Vercel AI Gateway as fallback; every bot, including the Coordinator, is a durable loop on [Vercel Workflow](workflows/coordinator) |
| Triage | Vision-capable Decision model for event meaning, actual image inputs when supplied, existing allow / ask / deny authority and mechanical checks |
| Data | Postgres on Neon, Drizzle migrations in [`drizzle/`](drizzle) |
| Auth | Better Auth, with email, Google and GitHub sign-in, Cloudflare Turnstile on email sign-up, and an OAuth 2.1 server for MCP |
| Billing | Stripe Checkout and webhooks |
| Flags | PostHog |
| Integrations | GitHub and Linear webhooks; Composio for Gmail, Google Calendar, Notion and Slack; Cloudflare Workers for scheduled work and Linear sync; Vercel Chat SDK for Telegram and Slack; Firecrawl for web search |
| Cloud computer | E2B sandboxes with a noVNC desktop |
| Credentials | Saved-login broker with AWS KMS, run-scoped task Secret delivery, explicit direct-exposure compatibility, platform secrets in Infisical |
| Subscriptions | A Go worker in [`packages/subscription-worker`](packages/subscription-worker), with secrets in Infisical |
| Agents | The Mikka daemon runs Claude Code, Codex or Cursor through a CLI adapter for each thread |

See [shared runtime operations](docs/operations/web-runtime.md) for build, start and rollback steps.

## Repository layout

```text
app/                 # Shared pages, action sources and API handlers (MCP, webhooks, cron, daemon /v1)
components/          # React UI
lib/                 # Domain logic: coordinator, issues, billing, factory, computer, MCP, auth
workflows/           # Durable workflows (Coordinator, Slack, sub-agents, thread machines, run publication)
agents/              # Built-in bot definitions
apps/frontend/       # Shared Vite renderer for web and desktop
apps/api/            # Hono/Nitro runtime and server compatibility adapters
apps/desktop/        # macOS desktop app (Electron)
apps/mobile/         # iOS app (Expo)
packages/daemon/     # Local daemon and Agent CLI adapters
packages/protocol/   # Types shared by the server, the daemon and the desktop app
packages/config/     # Shared configuration
packages/subscription-worker/  # Go worker for connected subscriptions
services/credential-broker/    # Decrypts saved logins for the vault
cloudflare/          # Workers for device/live transport, maintenance and Linear sync
drizzle/             # Database migrations
messages/, i18n/     # English and Simplified Chinese strings
tests/               # Unit, database and API acceptance tests, retained browser fixtures
docs/                # Engineering and design docs
factory.yaml         # The reviewed Factory definition
```

## Development

Development and functional acceptance run in cloud Linux against a local
application, a real isolated Postgres database and, when relevant, a real
daemon. Builds, type checks and API/CLI acceptance run there; CI runs source,
daemon and database checks.
Credentials live in Infisical Cloud; never commit them or store them in a local
`.env` file.

Use Node 24.x and pnpm 10.34.3. In a fresh cloud Linux session, the bootstrap
script installs PostgreSQL 17, migrates `mikka_e2e`, installs Node and dependencies,
and prepares the sandbox tools. It uses the image's Chromium when available.
See [local bootstrap](docs/local-bootstrap.md).

```sh
eval "$(scripts/dev/bootstrap-local.sh)"
```

To install dependencies in a provisioned session and run the source checks,
use the following commands.

```sh
pnpm install --frozen-lockfile
pnpm check
```

To prepare the isolated test database and start the Vite frontend with the
Hono/Nitro API at `http://localhost:3000/mikka`, run the following commands.

```sh
pnpm test:e2e:setup
pnpm dev
```

Desktop development builds the bundled Vite UI and sends API requests to that
server. Run the shell with the following command.

```sh
pnpm desktop:dev
```

While working in cloud Linux, run `pnpm typecheck`, `pnpm lint` and the unit
and database tests for what you changed. Ordinary acceptance follows the
API/CLI policy in [runtime acceptance](docs/acceptance.md). UI changes carry
screenshots of a local production build. `pnpm build`
compiles the app and subscription worker, checks types and applies database
migrations. `pnpm start` serves the compiled Node output.

The main CI workflow selects affected source, unit, daemon and PostgreSQL checks
with Nx Core. Its browser gate preserves the required check name. Targeted
runtime workflows have their own build and browser checks. The Web deploy
workflow builds `main` on a GitHub runner and uploads the prebuilt output to
Vercel. See [dependency-aware CI](docs/ci/incremental.md) and
[Web deployment](docs/operations/web-deploy.md).

### Additional test drivers

These drivers have prerequisites beyond the default source and database checks.
Use cloud Linux for their isolated application and daemon environments.

| Test | Needs | Execution scope |
| --- | --- | --- |
| `pnpm test:factory-http` (`tests/factory-{query,question,monitor-cycle}-http.test.ts`) | A production build (`pnpm build`), `eval "$(bash scripts/dev/bootstrap-local.sh)"` (which exports `BETTER_AUTH_SECRET` from a random local file). The runner points its server's `BETTER_AUTH_URL` at its own origin. In local test-account mode the runner creates the probes' own non-superuser database roles (`factory192`, `factoryquestions192`, `factorycycle192`) on the loopback `*_e2e` database | Run explicitly against a prepared isolated build |
| `pnpm test:test-accounts-http` (`tests/test-account-pool.http.test.mjs`) | A production build and a disposable test environment registered with `scripts/test-accounts/bootstrap.mjs` | Same prepared isolated-build requirement |
| `pnpm test:local-loop` and its `:mailbox`, `:cloud`, `:worker-mailbox` variants | `dev:local`, a real daemon, a model API key; the cloud item needs an E2B template | The existing driver requires a DeepSeek API key and refuses CI identities. Subscription acceptance follows [runtime acceptance](docs/acceptance.md) |
| `tests/byos-handoff-browser.test.mjs` | Chromium at `/usr/bin/chromium` | Standalone Linux browser fixture outside `pnpm test:byos`. HTTPS destinations are intercepted locally |
| `packages/daemon/test/codex-contract.node-test.mts` | The official Codex CLI, passed as `CODEX_CONTRACT_BIN`; without it the test skips | Opt-in contract probe, outside the default daemon test command |

Start with these documents:

- [Documentation index](docs/README.md) for setup, architecture, operations and design.
- [`AGENTS.md`](AGENTS.md): the rules every contributor and coding agent follows.
- [`docs/design/README.md`](docs/design/README.md): read before any design,
  spec or UI work.
- [`docs/design/glossary.md`](docs/design/glossary.md): what bot, thread and
  chat mean.
- [`docs/acceptance.md`](docs/acceptance.md): how a change is accepted.
- [`docs/dev-workflow.md`](docs/dev-workflow.md): local first, issue
  ownership and merging, and production acceptance after a merge.
- [`docs/review-checklist.md`](docs/review-checklist.md): complete before
  presenting UI to others.
- [`apps/desktop/README.md`](apps/desktop/README.md): running and packaging
  the desktop app.

## Get access

Mikka is in early access. Email
[mikka@aspectlylabs.com](mailto:mikka@aspectlylabs.com) for an invite, then
follow the [Quickstart](https://aspectlylabs.com/mikka/docs/quickstart).

## Acknowledgements

<p>
  <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/openai-mark-dark.svg">
      <img src="docs/assets/openai-mark-light.svg" alt="OpenAI logo" width="32" height="32">
    </picture>
  <strong>OpenAI · Codex for Open Source</strong>
</p>

Mikka is proudly developed with support from the [Codex for Open Source](https://openai.com/form/codex-for-oss/) program.

A heartfelt thank-you to OpenAI and the Codex team for providing Mikka's maintainer with six months of ChatGPT Pro access. This support gives us more room to explore ambitious ideas, improve engineering and user experience, and give back to the open-source community.

Mikka is an independent open-source project and is not affiliated with or endorsed by OpenAI. The OpenAI name and logo are trademarks of OpenAI.

## License

Mikka is copyright © 2026 Aspectly Labs and licensed under
[AGPL-3.0-only](LICENSE). Third-party components keep their own licenses; see
[`packages/daemon/THIRD_PARTY_NOTICES.md`](packages/daemon/THIRD_PARTY_NOTICES.md).

Commercial licenses for use without the AGPL's obligations are available from
Aspectly Labs: [legal@aspectlylabs.com](mailto:legal@aspectlylabs.com).

If you run a modified version of Mikka as a network service, the AGPL requires
you to offer its users the source code of your version.

## Contributing

Contributions are welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first.
Contributors keep the copyright in their work and license it under
[AGPL-3.0-only](LICENSE); by submitting it they also allow Aspectly Labs to
offer it under other terms, including commercial licenses. There is no form to
sign. The terms are in [`CONTRIBUTING.md`](CONTRIBUTING.md#license).
