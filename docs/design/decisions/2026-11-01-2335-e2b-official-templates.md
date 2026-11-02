# Machines start from E2B's own templates; runs use no sandbox and ask nothing per tool

- Date: 2026-11-01
- Source: Alex, relayed by the coordinator session: 「codex 做了一些工作，现在已经确认 e2b 提供模板，bot 直接使用 desktop 模板，干活的 agent 直接用 Claude 和 codex 模板，去掉 Anthropic sandbox runtime 包装」;
  for a person's own computer or server: 「自己的服务器和电脑直接走自己的Claude/codex，也不做沙箱了」;
  for permissions: 「那就不要decision api 了，直接走bypass」
- Rule: —
- Replaces: [2026-11-01-1201 template public, released by CI](2026-11-01-1201-e2b-template-public-auto-release.md)
  (Mikka's own worker template), the sandbox-runtime part and the device
  paragraph of [2026-11-01-1312 cloud runs without Docker](2026-11-01-1312-cloud-runs-without-docker.md),
  and every per-tool or per-destination permission ask of a run
- See also: [2026-11-01-2331 reuse the official E2B desktop](2026-11-01-2331-use-official-e2b-desktop.md) for the desktop recipe
- See also: #843 (zero added start latency); builds on #847, #849, #856, #862 and #863, all on `main`

## Decision

- **A bot's computer** runs on E2B's official **desktop** template with
  Mikka's worker, Node, the pinned Claude Code and Codex, the viewer gateway,
  lease driver and desktop driver added on top (the recipe of
  [2331](2026-11-01-2331-use-official-e2b-desktop.md)). Mikka no longer
  assembles its own desktop image.
- **The agent that does a repository task** runs on a machine started from
  E2B's **`claude`** or **`codex`** template with Mikka's worker added,
  picked by the run's harness: `claude_code` → `claude`, `codex` → `codex`.
  One task, one machine (1312) stays: that machine is the isolation between
  tasks.
- **No sandbox anywhere.** No `@anthropic-ai/sandbox-runtime`, no Docker
  container per run, no Claude Code or Codex sandbox, on E2B and on a
  person's own computer or server alike. The daemon starts the CLI directly as
  its own user.
- **Nothing is asked per tool or destination.** Claude Code runs in
  `bypassPermissions` (CLI `--permission-mode bypassPermissions` /
  `--dangerously-skip-permissions`; Agent SDK `permissionMode:
  "bypassPermissions"` with `allowDangerouslySkipPermissions: true`). Codex
  runs with no approvals and no sandbox (CLI
  `--dangerously-bypass-approvals-and-sandbox`, alias `--yolo`; app-server
  `approvalPolicy: "never"`, `sandbox: "danger-full-access"`), not
  `--full-auto`, which is the sandboxed Auto preset that still asks. The
  Decisions API no longer judges a run's commands, network destinations,
  setup recipes or unset permissions. Sources:
  https://code.claude.com/docs/en/permission-modes,
  https://developers.openai.com/codex/agent-approvals-security.

## What E2B documents (checked 2026-11-01)

| Use | Template | What the docs say | Source |
| --- | --- | --- | --- |
| Task agent, Codex | `codex` | 「E2B provides a pre-built `codex` template with Codex already installed」. `Sandbox.create('codex', { envs: { CODEX_API_KEY } })`; headless with `codex exec --full-auto --skip-git-repo-check`. A derived template starts `.fromTemplate('codex')`. The docs warn that sandboxes reach the internet by default; limit it with network rules. | https://docs.e2b.dev/agents/codex |
| Task agent, Claude Code | `claude` | 「E2B provides a pre-built `claude` template with Claude Code already installed」. `Sandbox.create('claude', { envs: { ANTHROPIC_API_KEY } })`; headless with `claude --dangerously-skip-permissions -p "…"`. | https://docs.e2b.dev/agents/claude-code |
| Bot computer | `desktop` (`default_template = "desktop"` in the `e2b-desktop` 2.7.2 SDK) | `@e2b/desktop`'s `Sandbox.create()` with no template name is 「created from the default desktop sandbox template」, with streaming (`stream.start()`, `getUrl()`), `screenshot()`, mouse and keyboard. A self-built recipe (Ubuntu 22.04, XFCE, VNC/noVNC) is also documented. | https://docs.e2b.dev/use-cases/computer-use, https://docs.e2b.dev/sdk-reference/desktop-python-sdk/v2.4.2/desktop, https://docs.e2b.dev/template/examples/desktop |

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

- **Everything on a cloud machine runs as the template's default `user`.**
  No extra users, no wrapper inside the machine, sudo as the template ships
  it. The agent can read the worker's files, including its device
  credential; Alex accepts this (2026-11-01: 「我完全接受 Agent 能够读到
  worker 凭证的这个风险……哪怕就是 Claude Code，Agent 也是能够看到凭证的」). The E2B
  sandbox, one per task, is the only boundary.
- **Credentials keep the existing path** (subscription or API key through
  Mikka's gateway or BYOK broker); the CLI still gets a placeholder and reaches
  the model only through the run's broker. Nothing new is stored or logged.
- **What stays in plain code:** git push is the daemon's (a read-only run
  never pushes, an unadmitted run never pushes); Claude Code's deny rules for
  `git push`, read-only edit tools and denied installs; Codex's shell tool is
  off when installs are not allowed; the run's live gate still stops a run
  whose lease, owner or policy is no longer live. The desktop's computer
  broker keeps its own policy and its `computer-action` judgment.
- **No network ceiling is enforced.** The run's network policy is still in the
  agent's instructions, but nothing filters its connections any more.
- **A read-only run can write its worktree.** The agent of a read-only check
  (ADR 0046) and the verify command run after its hand-in
  (`packages/daemon/src/agents/verify.ts`) are no longer kept from writing
  the worktree, its `.git` or credential stores. Such a run still never
  commits or pushes (`packages/daemon/src/runs/supervisor.ts`), so a write
  stays on that machine; a check whose command changes files reports on the
  changed tree.
- Anything a run needs before it starts goes into the template or is passed at
  create time (envs, metadata), so the agent starts when E2B reports the
  machine ready (#843).

## How it is built

- `scripts/e2b/build-template.py` builds three templates in one run, each
  `Template().from_template(<official>)` plus the worker: `desktop` (with
  `bootstrap-desktop.sh` and the viewer and preload boot services), `claude`
  and `codex` (preload service only; the codex one gets the daemon-pinned
  Codex whose interface the daemon audited, the claude one runs the Agent
  SDK's own Claude Code build). `scripts/e2b/bootstrap.sh` adds Node 24 and
  the worker's tools and creates no user.
- `.github/workflows/e2b-template.yml` builds and publishes them when the
  worker hash changes, and `scripts/e2b/publish-template-env.mjs` sets
  `E2B_BYO_COMPUTER_TEMPLATE` (desktop), `E2B_CLAUDE_TEMPLATE`,
  `E2B_CODEX_TEMPLATE` and `MIKKA_CLOUD_WORKER_SHA` in one Vercel request.
- `lib/secrets/e2b-runtime.ts` `taskTemplate(harness)` picks a repository
  task's template (`lib/cloud-computer/thread-machines.ts`); a task machine
  has no desktop, so its worker starts no computer broker.
- The daemon (`packages/daemon`) has no sandbox-runtime dependency, no per-run
  Docker container, no per-tool approval policy and no egress proxy; see the
  pull request that adds this section for the files.
