# Cloud machines use E2B's own templates; no sandbox-runtime wrapper

- Date: 2026-11-01
- Source: Alex, relayed by the coordinator session: 「codex 做了一些工作，现在已经确认 e2b 提供模板，bot 直接使用 desktop 模板，干活的 agent 直接用 Claude 和 codex 模板，去掉 Anthropic sandbox runtime 包装」
- Rule: —
- Replaces: [2026-11-01-1201 template public, released by CI](2026-11-01-1201-e2b-template-public-auto-release.md)
  (Mikka's own worker template) and the sandbox-runtime part of
  [2026-11-01-1312 cloud runs without Docker](2026-11-01-1312-cloud-runs-without-docker.md)
- See also: #843 (zero added start latency), #847 (Codex handoff)

## Decision

- **A bot's computer** runs on E2B's **desktop** template, not on a template
  Mikka builds.
- **The agent that does a task** runs on E2B's **Codex** or **Claude Code**
  template, picked by the run's harness: `codex` for Codex, `claude-code` for
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
| Task agent, Claude Code | `claude-code` | The template example installs `@anthropic-ai/claude-code` globally as `claude` and builds it under the name `claude-code`; the sandbox is then `Sandbox.create('claude-code', …)`. The page shows building it; it does not say a public prebuilt copy exists. | https://docs.e2b.dev/template/examples/claude-code |
| Bot computer | `desktop` | Ubuntu 22.04 with XFCE, Xvfb, x11vnc on 5900 and noVNC on 6080, xdotool and scrot; the example builds it under the name `desktop`. E2B's Desktop SDK (`@e2b/desktop`) is the client for computer use. | https://docs.e2b.dev/template/examples/desktop, https://e2b.dev/docs/use-cases/computer-use |

Before building on them, confirm which of these are public prebuilt templates
for our key (`Sandbox.create('<name>')` succeeds, or `e2b template list`).
Where a page only shows how to build one, Mikka builds it from E2B's recipe
with `.fromTemplate(...)` and changes nothing else.

## What follows

- The worker that talks to Mikka (claims runs, holds the device credential,
  the broker and the model key) is not something the agent can read. Without
  sandbox-runtime, that means the agent's machine holds only what the run
  needs: a run-scoped credential and the model access the broker grants. How
  the worker and the agent are separated on that machine is part of the
  implementation and needs its own review.
- Anything a run needs before it starts goes into the template or is passed at
  create time (envs, metadata), so the agent starts when E2B reports the
  machine ready (#843).
- `scripts/e2b/build-template.py`, the worker hash and `e2b-template.yml`
  (1201) stay until the new path replaces them; nothing is removed by this
  record.

How it is built: not yet. The code and CI that still use sandbox-runtime or
Mikka's own template are listed in the pull request that adds this record;
Codex changes them (#838).
