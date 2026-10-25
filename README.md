# Mikka

> **Your AI lead built for ambitious work — every agent, from laptop to cloud, working as one team.**
>
> 为大事而生的 AI lead：从本地到云端，所有 Agent 协作如一。

Mikka is a workspace where you chat with bots and they get work done. A bot
talks with you, breaks the ask into tasks and dispatches each one to a thread.
Threads do the work with coding agents such as Claude Code and Codex, on a
cloud computer or on your own machine. Mikka was called Orvilo before; some
environment variables and database names still carry the old name.

User docs: [aspectlylabs.com/mikka/docs](https://aspectlylabs.com/mikka/docs)
(source in [mikka-web](https://github.com/alexj11324/mikka-web)). The docs in
this repository are for people working on Mikka.

## The product in one screen

| Column | What it shows |
| --- | --- |
| Left: **bot list** | Your bots and group chats. The Coordinator is an ordinary bot here. |
| Centre: **chat** | The conversation with the selected bot or group. In a group chat one bot answers. |
| Right: **detail panel** | The selected bot, its screen (cloud computer), its threads and tasks, and suggestions. |

The exact meaning of bot, chat and thread is in
[`docs/design/glossary.md`](docs/design/glossary.md). Use those words in code,
specs and issues.

Main parts:

- **Bots** run on Mikka's own harness: Vercel AI SDK plus Vercel Workflow for
  sleep and wake, with state in Neon (`lib/coordinator/`, `workflows/coordinator/`).
- **Threads** run coding agents. The local daemon (`packages/daemon`) drives
  the user's own CLIs; cloud threads run on a shared E2B machine with one
  desktop per bot ([cloud computer backend](docs/design/cloud-computer-backend.md)).
- **Decision model**: one typed call to the OpenAI Decisions API through AI
  Gateway (`lib/coordinator/decision.ts`). It triages events, picks which bot
  answers in a group chat, judges task scope and filters suggestions, with
  fixed rules as the fallback.
- **Suggestions** are notifications from connected apps (GitHub, Linear,
  Notion, Slack, Gmail through Composio webhooks) that the decision model judged
  worth showing, plus a daily briefing (`lib/suggestions/`).
- **Tasks** live on the board and list views and sync both ways with Linear
  ([docs/linear-sync.md](docs/linear-sync.md)).
- **Mikka MCP server** at `/mikka/api/mcp` lets agents read and change tasks
  ([docs/mcp.md](docs/mcp.md)).
- **Telegram** bot for creating and linking issues from private chats
  ([docs/telegram.md](docs/telegram.md)).

## Stack

Next.js (App Router, served under `/mikka`), Better Auth with Google and
GitHub, Neon Postgres with SQL migrations in `drizzle/`, shadcn and reUI
components, OpenUI for rich bot replies, Cloudflare Workers for the Linear sync
(`cloudflare/`). Secrets live in Infisical Cloud. The repository is linked to
[v0](https://v0.app/chat/projects/prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH); every merge
to `main` deploys to [app.aspectlylabs.com/mikka](https://app.aspectlylabs.com/mikka).

## Working on Mikka

Read [`AGENTS.md`](AGENTS.md) first. In short:

- Develop and accept changes on cloud Preview deployments, not on a local dev
  server. Builds and type checks run in CI. Setup for previews, OAuth and
  Composio: [docs/cloud-preview.md](docs/cloud-preview.md).
- Runtime acceptance follows [docs/acceptance.md](docs/acceptance.md).
- Before any design or UI work, start at
  [`docs/design/README.md`](docs/design/README.md) (glossary, rules,
  components, decisions) and run [docs/review-checklist.md](docs/review-checklist.md)
  before showing UI.
- Credentials go in Infisical ([docs/infisical-cloud.md](docs/infisical-cloud.md)),
  never in committed files or `.env.local`.
- Migrations: [docs/migration-bootstrap.md](docs/migration-bootstrap.md).

Common scripts: `pnpm lint` (code, migrations and UI rules), `pnpm test:e2e`
(Playwright), and the `pnpm test:*` unit suites listed in `package.json`.

## Repository map

| Path | What |
| --- | --- |
| `app/` | Routes, pages and API handlers |
| `components/` | UI, grouped by feature |
| `lib/` | Server and shared logic: `coordinator/`, `suggestions/`, `db/`, auth, integrations |
| `workflows/coordinator/` | Vercel Workflow definitions for bots |
| `packages/` | `daemon` (local agent runner), `protocol` (shared types and policies), `config` |
| `drizzle/` | SQL migrations |
| `cloudflare/` | Workers (Linear sync) |
| `messages/` | UI copy in `zh-CN` and `en` |
| `docs/` | Internal docs; `docs/design/` for design rules |
| `scripts/`, `tests/` | Lint and policy scripts, unit and E2E tests |
