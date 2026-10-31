# A person's device is a runner, like an E2B sandbox

- Date: 2026-10-31
- Source: Alex, relayed by the coordinator session: 「把本机和我们自己的服务器，其实就相当于是一个特殊的…E2B 的服务器」 and 「应该放到 MVP 里边来做」.
- Rule: —
- Replaces: local threads running "with the installed Claude Code or Codex" on a computer (docs/local-runtime.md, ADR 0003 and 0009 where they keep the person's own login).

A device (the Mac app's daemon, or a server running the daemon) has the same
contract as an E2B sandbox:

- Each run starts clean: its own worktree and its own harness home.
- The daemon installs pinned Claude Code and Codex into its own data dir
  (`harness/<name>/<version>`) from the official npm packages, checked
  against the integrity pinned in `packages/daemon/harness/pins.json`. A
  daemon release that moves a pin installs the new version on the next run.
  The E2B template installs Codex from the same pins.
- The run's credential comes from the model resolver for the bot's owner (the
  owner's subscription, or another member's allowOthers share) and is handed to
  the CLI at run start, in memory or on a pipe. Any credential file a CLI writes
  in its run home is deleted when the run ends, and on the next daemon start
  after a crash or kill.
- The daemon never uses, reads or changes agents the person installed, their
  logins or their config (`~/.claude`, `~/.codex`, Keychain entries, PATH).
- A device reports what it can run (OS/arch, free disk, Docker, each managed
  harness's install state), not which agents are installed. Pickers no longer
  require the person to install Claude Code or Codex.

## Harness per model

Added by Alex the same day: GPT/OpenAI models run on Codex; every other
model (Mikka 默认, models reached through an API key or a custom provider)
runs on Claude Code (`harnessForModel` in `@mikka/protocol`). A per-model
override in settings wins, and more harnesses can be added later. A run's
credential is a subscription token, an API key, or a custom provider (base
URL plus protocol plus key): Anthropic-compatible endpoints go to Claude Code
as `ANTHROPIC_BASE_URL` plus key, OpenAI-compatible endpoints go to Codex as a
custom model provider in the run's config, with the key only in its env.
