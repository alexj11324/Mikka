# Cloud machines use E2B's own templates; no sandbox-runtime wrapper

- Date: 2026-11-01
- Source: Alex, relayed by the coordinator session: 「codex 做了一些工作，现在已经确认 e2b 提供模板，bot 直接使用 desktop 模板，干活的 agent 直接用 Claude 和 codex 模板，去掉 Anthropic sandbox runtime 包装」
- Rule: —
- Replaces: [2026-11-01-1201 template public, released by CI](2026-11-01-1201-e2b-template-public-auto-release.md)
  (Mikka's own worker template) and the sandbox-runtime part of
  [2026-11-01-1312 cloud runs without Docker](2026-11-01-1312-cloud-runs-without-docker.md)
- See also: #843 (zero added start latency); builds on #847, #849, #856, #862 and #863, all on `main`

## Decision

- **A bot's computer** runs on E2B's **desktop** template, not on a template
  Mikka builds.
- **The agent that does a task** runs on E2B's **Codex** or **Claude Code**
  template, picked by the run's harness: `codex` for Codex, `claude` for
  Claude Code. One task, one machine (1312) stays: that machine is the
  isolation between tasks.
- **No `@anthropic-ai/sandbox-runtime` around the CLI.** The E2B sandbox is
  the isolation boundary. The CLI runs directly in it (for example
  `codex exec --full-auto --skip-git-repo-check "…"`), and what must stay out
  of the agent's reach stays outside that machine (see below).

## What E2B documents (checked 2026-11-01)

| Use | Template | What the docs say | Source |
| --- | --- | --- | --- |
| Task agent, Codex | `codex` | 「E2B provides a pre-built `codex` template with Codex already installed」. `Sandbox.create('codex', { envs: { CODEX_API_KEY } })`; headless with `codex exec --full-auto --skip-git-repo-check`. A derived template starts `.fromTemplate('codex')`. The docs warn that sandboxes reach the internet by default; limit it with network rules. | https://docs.e2b.dev/agents/codex |
| Task agent, Claude Code | `claude` | 「E2B provides a pre-built `claude` template with Claude Code already installed」. `Sandbox.create('claude', { envs: { ANTHROPIC_API_KEY } })`; headless with `claude --dangerously-skip-permissions -p "…"`. | https://docs.e2b.dev/agents/claude-code |
| Bot computer | default desktop template | `@e2b/desktop`'s `Sandbox.create()` with no template name is 「created from the default desktop sandbox template」, with streaming (`stream.start()`, `getUrl()`), `screenshot()`, mouse and keyboard. A self-built recipe (Ubuntu 22.04, XFCE, VNC/noVNC) is also documented. | https://docs.e2b.dev/use-cases/computer-use, https://docs.e2b.dev/sdk-reference/desktop-python-sdk/v2.4.2/desktop, https://docs.e2b.dev/template/examples/desktop |

`codex` and `claude` are documented as pre-built. Before building on them, confirm all three
are usable with our key (`Sandbox.create('<name>')` succeeds, or `e2b template list`).
Where a page only shows how to build one, Mikka builds it from E2B's recipe
with `.fromTemplate(...)` and changes nothing else.

Checked with a real key on 2026-11-01 (each sandbox killed right after):

| Template | Boot | OS | Installed | Default user |
| --- | ---: | --- | --- | --- |
| `claude` | 0.59 s | Ubuntu 24.04.5 | Claude Code 2.1.305 at `/home/user/.local/bin/claude`, node, git | `user` (1001), passwordless sudo |
| `codex` | 0.39 s | Debian 12 | codex-cli 0.164.0 at `/usr/local/bin/codex`, node, git | `user` (1000), passwordless sudo |
| default desktop (`@e2b/desktop`) | 4.83 s | Ubuntu 22.04.5 | python3, git; no agent CLI | `user` (1000), passwordless sudo |

## What follows

- **The worker's secrets stay out of the agent's reach by Unix users, not a
  wrapper** (coordinator, confirmed for Alex 2026-11-01): the worker and
  everything it holds (device credential, RPC secret, journal, logs, session
  ledgers, the broker's model key) belong to the worker's user with 0600/0700
  modes; the agent runs as its own unprivileged user with no sudo, reaching
  only the run's worktree and the broker and egress sockets. The templates'
  default `user` has passwordless sudo, so the agent never runs as `user`.
  A test reads the worker's credential file as the agent user and must fail.
- **The model key stays with the broker**: it never goes into the agent's
  environment, even though E2B's examples pass `ANTHROPIC_API_KEY` /
  `CODEX_API_KEY` as envs. Credentials keep the existing path (subscription or
  API key through Mikka's gateway or BYOK); nothing new is stored or logged.
- **`--dangerously-skip-permissions` and `--full-auto` only on E2B.** A run on
  a person's own computer or server keeps the daemon's current isolation and
  permission modes unchanged.
- Anything a run needs before it starts goes into the template or is passed at
  create time (envs, metadata), so the agent starts when E2B reports the
  machine ready (#843).
- `scripts/e2b/build-template.py`, the worker hash and `e2b-template.yml`
  (1201) stay until the new path replaces them; nothing is removed by this
  record.

How it is built: not yet. The code and CI that still use sandbox-runtime or
Mikka's own template are listed in the pull request that adds this record;
Codex changes them (#838).
