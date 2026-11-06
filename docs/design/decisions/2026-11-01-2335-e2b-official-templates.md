# Machines start from E2B's own templates; runs use no sandbox and ask nothing per tool

- Date: 2026-11-01
- Source: Alex, relayed by the coordinator session: 「codex 做了一些工作，现在已经确认 e2b 提供模板，bot 直接使用 desktop 模板，干活的 agent 直接用 Claude 和 codex 模板，去掉 Anthropic sandbox runtime 包装」;
  for a person's own computer or server: 「自己的服务器和电脑直接走自己的Claude/codex，也不做沙箱了」;
  for permissions: 「那就不要decision api 了，直接走bypass」
- Rule: —
- Superseded in part by: [2026-11-03-1430-official-e2b-templates-unchanged](2026-11-03-1430-official-e2b-templates-unchanged.md) (official files stay intact; additive versioned derivatives are allowed under #1505)
- Superseded in part by: [2026-11-06-1800](2026-11-06-1800-machine-is-the-execution-boundary.md) for credential delivery, ordinary HOME/environment/Git and removal of extra per-call remote authorization.
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
- **Credentials and authority are prepared up front** ([1800](2026-11-06-1800-machine-is-the-execution-boundary.md)).
  Give the assigned machine the task's real subscription, GitHub and model
  credentials. Claude Code and Codex connect directly to their providers;
  no placeholder, model proxy or extra remote permission check precedes each
  tool or provider call. Use the machine's normal HOME, environment and `.git`.
- **Stops replace per-call gates.** A revoked connection, share or task causes
  a persisted stop to be pushed to the runner, or the VM to be reclaimed.
  Existing scheduling heartbeats carry lifecycle state. GitHub operations use
  the assigned person's real credential and the Agent's judgment under
  [1600](2026-11-02-1600-agents-use-own-github-credential.md).
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

- `scripts/e2b/build-template.py` builds three versioned private candidates
  with `Template().from_template(<official>)`. All Mikka Node, worker,
  dependencies, `gh` and any missing CLI live under `/opt/mikka`. Original
  official CLI bytes and paths remain intact; the official CLI is passed
  explicitly to the daemon. The build freezes an anonymous preloaded worker,
  with no task login or device identity in the reusable image.
- `.github/workflows/e2b-template.yml` only builds candidates. The coordinating
  `e2b-official-runtime.yml` checks original-file conservation and executes
  both real official subscriptions on those exact candidates before making
  them public. The application source, worker digest, template IDs and model
  reports must agree. See [1430](2026-11-03-1430-official-e2b-templates-unchanged.md)
  for the complete release gates and rollback contract.
- `scripts/e2b/publish-template-env.mjs` writes the three template IDs, worker
  digest, source commit and measured model catalogue in one upsert, then reads
  every value back. A partial or mismatched tuple refuses release and requires
  revalidation; it never overwrites the last valid previous configuration.
- `lib/secrets/e2b-runtime.ts` picks the task's template from the matching
  released catalogue. A task machine has no desktop, so its worker starts no
  computer broker. New tasks receive the normal owner-bound handoff after
  creation; the preloaded process does not rely on create-time environment
  changes to deliver credentials.
