# Mikka

> **Your AI lead built for ambitious work — every agent, from laptop to cloud, working as one team.**
>
> 为大事而生的 AI lead：从本地到云端，所有 Agent 协作如一。

Mikka is where you hand work to AI and watch it get done. Tell a bot what you
need in plain words. It turns the ask into tasks and starts the coding agents
you already use, such as Claude Code and Codex, on a cloud computer or on your
own machine. You follow each piece of work, step in when it needs you, and
review the result.

**Open Mikka:** [app.aspectlylabs.com/mikka](https://app.aspectlylabs.com/mikka)
· **Docs:** [aspectlylabs.com/mikka/docs](https://aspectlylabs.com/mikka/docs)

## What you can do

- **Chat with bots.** Create bots for different kinds of work, or put several
  in a group chat. Each bot plans the work and hands it out.
- **Follow every piece of work.** Each task runs in its own thread. You can see
  what it is doing, watch its computer screen, and take over when you want to.
- **Run agents anywhere.** Use Mikka's cloud computer, or connect your own Mac,
  Linux machine or server.
- **Keep tasks in one place.** Tasks show on a board and a list, and sync both
  ways with Linear.
- **Catch what matters.** Mikka reads notifications from GitHub, Linear,
  Notion, Slack and Gmail, and shows only the ones worth your time, plus a
  short daily briefing.
- **Work from other tools.** Drive Mikka from Claude Code or Codex through its
  MCP server, or create tasks from Telegram.

## How it works

- **Bots are long-running and cheap to keep around.** Each bot runs on
  Mikka's own agent runtime, built on the Vercel AI SDK and durable workflows.
  A bot sleeps while nothing is happening and wakes when you write to it, a
  task changes, or an agent reports back.
- **Real coding agents do the work.** Mikka does not reimplement Claude Code or
  Codex. A small daemon starts the official command line tools on the chosen
  machine, signed in with your own account, and streams what they do back into
  the task's thread.
- **One record of everything.** Chats, tasks, runs and their events live in one
  Postgres database, so the board, the threads, Linear sync and the MCP server
  all read the same state.
- **Agents act as you, with your permissions.** Tools reached over MCP go
  through the same checks as the app itself.

## Get started

Mikka is in early access. Email
[hello@aspectlylabs.com](mailto:hello@aspectlylabs.com) for an invite, then
follow the [Quickstart](https://aspectlylabs.com/mikka/docs/quickstart).

## Contributing

Developer setup and project rules are in [`AGENTS.md`](AGENTS.md) and
[`docs/`](docs/).
