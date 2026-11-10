# Cloud computer backend

This document retains the original backend handoff and its proposed frontend
contract. The implementation has evolved since the 2026-10-27 handoff. Sections
3–7 retain verification questions and proposed shapes from that work. Resolve
actual route and storage contracts against `lib/computer/`,
`lib/cloud-computer/`, `app/api/bots/[botId]/computer/` and
`packages/protocol/src/computer.ts`.

Accepted execution rules are [one task, one machine](decisions/2026-11-06-1800-machine-is-the-execution-boundary.md),
[additive official templates](decisions/2026-11-03-1430-official-e2b-templates-unchanged.md)
and the separate [credential exposure boundary](decisions/2026-11-08-0240-credential-exposure-boundary.md).
[Orchestration](orchestration.md) owns model, machine, scheduling and billing
rules. E2B sandboxes use their owner's personal E2B key. Bot machines are keyed
by workspace and owner. A task's cloud machine belongs exclusively to that task.

- Design review page: https://claude.ai/artifact/G8aEuFM4rwvGFeZbPYyVwU
- Figma: file `zPe5LKycb2XuT1ivCLRw07`, section "云端电脑" (node `102:65`)
- Related: #147 (computer use), #161 (local CUA driver, approvals), #157
  (remote desktop, superseded by this document)

## 1. What the user sees

Every bot has its own desktop on its owner's Bot machine in the workspace.
Bot and thread are defined in [glossary.md](glossary.md). A Bot uses that
desktop for its own work. Cloud task runs use their task's separate machine.
The Bot computer is keyed by `bots.id`, never `agents.id`.

- **电脑 tab (right panel)**: the selected bot's existing `AgentComputer`
  view. The 概览 header shows the bot's avatar and name, not a screen caption
  (decision 2026-10-28, R-02).
- **Full-window viewer**: starts view-only (仅观看). 取得控制权 pauses the agent
  and gives the user mouse and keyboard (你在操作); 交还给 <Bot 名> hands control back.
- **Chat**: one 电脑 card per computer task. It shows the task sentence, a state
  (<Bot 名> 操作中 / 等你审批 / 完成) and the live screen. Approval happens inside
  the card (允许 / 拒绝 / 本任务内都允许). There is no step list and no operation
  log anywhere.
- **Sleep**: the computer sleeps when idle and keeps its disk. It wakes
  automatically when an agent needs it, or when the user presses 唤醒.
- **设置 › 设备** lists only machines the user connected (this Mac, SSH hosts,
  Tailnet machines). Mikka Cloud is never listed there: it runs on the
  person's own E2B key.
- **连接电脑** opens the daemon installation and sign-in commands described
  in [daemon-connection.md](daemon-connection.md). Server enrollment retains
  its separate SSH path.

## 2. Architecture

Revised 2026-10-27 (Alex; `decisions.md`, R-72). The 2026-10-24 version put
every bot and every cloud thread on one machine per workspace. Threads build,
install and test, which is heavy, so they now get machines of their own, as in
Cursor's cloud agents, Devin, Codex cloud and Copilot's coding agent. Bots stay
on one shared machine, as in Grok Bot: since 2026-10-29 one per person per
workspace (`cloud_machines` primary key `workspaceId`, `ownerId`, migration
`20261029080001_owner_cloud_machines.sql`), so one person's bots share it and
another member's bots never do.

```
owner + workspace ──1:1── bot machine (E2B sandbox, Linux)
                    ├─ mikka daemon (device, kind = "cloud")
                    ├─ owner-scoped authentication (never shared across users)
                    ├─ bot A: Xvfb :1 + WM + x11vnc + websockify → noVNC
                    │         Chrome profile ~/.mikka/profiles/<botId>
                    ├─ bot A, web sub-agents: one headless Chrome each,
                    │         live view by CDP screencast
                    ├─ bot B: Xvfb :2 + …
                    └─ cookie sync between one owner's profiles only

cloud task ──1:1── task machine (verified official-derived E2B template)
                    ├─ mikka daemon running the coding harness (Claude Code, Codex)
                    ├─ /workspace: the repo at the thread's branch
                    └─ desktop (Xvfb + WM + VNC + Chrome) only when needed
```

### Bot machine (one per person per workspace)

- **Shared:** all of one person's bots in the workspace and their web sub-agents. The load is light: chat turns
  and browsers, no builds.
- **Bot desktops:** each bot keeps its own X display, window manager, apps,
  windows and VNC stream (R-04). Displays are allocated lazily on a bot's first
  computer use and kept across sleep.
- **Web sub-agents (R-72):** a bot runs each web task as a sub-agent with its
  own browser, several at once.
  - Each sub-agent gets a headless Chrome context, with no X display. Its live
    view is a CDP screencast (`Page.startScreencast`). There is no takeover of
    a sub-agent's screen.
  - **Login (Hark Secured Login precedent):** when a page needs credentials
    the sub-agent stops at `needs_you` with `needs: { kind: "login", site }`.
    The bot says so in a chat message and posts a 登录 <site> pill, which
    expands in place into the login card (site logo, 登录 <site>, ✕; 邮箱,
    密码; Google and Apple buttons and 登录; 🔒 Secured by Mikka). The person can ask the bot to send the card
    again.
    - 登录 submits to `POST /api/bots/:botId/subagents/:id/credentials`,
      which stores the login in the credential vault of #180; the design (envelope
      encryption, broker-only decrypt, fill path, threat model) is in
      `credential-vault.md`. There is no second vault. The bot machine then focuses the page's fields and types
      them with CDP `Input.insertText`.
    - The model only ever sees a reference (`credential:<site>`), never the
      value. The value never reaches logs, the transcript or the model
      context, and the screencast masks it as the page does.
    - The login belongs to the user's account, not a run or workspace: any of
      the user's threads and bot sub-agents uses it later without asking. The
      person can remove a saved login in Settings. Browsers may visit any
      site; the only check is that a site's password is filled on that site.
    - Google or Apple clicks the site's own 使用 Google/Apple 登录 and
      completes OAuth in the browser with the person's synced session; if
      that needs the person, the card asks again.
    - One-time codes (2FA) use the same card with a code field.
  - A sub-agent is not a run row in the thread list. It is owned by the bot
    and reported in the bot's chat.
  - Concurrency is capped per workspace (proposal: 6, Hark's figure). Further
    tasks queue.
- **Browser logins stay with their owner (#172):** Chrome locks a profile
  directory to one process, so each bot and each sub-agent gets its own
  profile or context. A background job syncs cookies only between profiles of
  the same account owner, for example with CDP `Network.getAllCookies` /
  `Network.setCookies`; there is never cross-user authentication-cookie sync.
  Saved logins come from the owner's vault (`credential-vault.md`). Project
  files may be shared in `/workspace`; a shared `$HOME` is not an
  authentication or security boundary. Until a stronger process or sandbox
  boundary exists, the runtime rejects a second account owner on the
  workspace's bot machine. Sites that pin a session to one device may still
  ask again; that is accepted.

### Task machine (one per cloud task)

- **One E2B sandbox per task.** Follow-up runs resume that task's retained
  machine. Another task never receives it.
- **Start.** Repository work selects the verified official-derived Claude or
  Codex template. Non-repository computer work selects desktop. The daemon
  clones the admitted repository and creates its task worktree. Reusable
  templates contain no account, task credentials or workspace data.
- **Credentials.** Supply the selected native CLI authentication and authorized
  GitHub credential through their normal mechanisms. Other third-party API
  Secrets follow the separate exposure decision. `taskSecretInjection()`
  separates ordinary environment and explicitly approved direct values from
  protected capabilities. See [task Secret delivery](../security/task-secret-delivery.md)
  for claim, compatibility and deployment evidence boundaries.
- **Lifecycle.** An open task's machine is paused between runs and resumed for
  its follow-up. Closed, canceled, duplicate or deleted tasks are retired by
  the task-machine lifecycle. Retained worktrees and native sessions belong
  to the task.
- **Desktop work.** A task that needs a screen uses its own desktop-capable
  machine. Claim refuses computer work on a device without the required
  desktop capability. The Bot's desktop remains reserved for Bot work.
- **Threads on the person's own devices** (their Mac, SSH hosts) are
  unchanged. They cannot see cloud screens; their acceptance runs on that
  device.

### Seeing and driving across machines

- **On the same machine:** any process can use a display (`DISPLAY=:N`), and
  any agent can drive a Chrome through its CDP port.
- **Viewer transport.** Remote viewing uses scoped, short-lived grants. A
  task requiring a desktop uses its own desktop machine under
  [0251](decisions/2026-11-02-0251-desktop-runs-get-their-own-machine.md).
  Its Agent does not drive the Bot's desktop through a cross-machine port.
- **One driver per screen:** control is `agent | user | idle` plus the holder
  (bot, sub-agent, thread or person). A second driver waits; it does not fail.

### Sleep

- **Bot machine:** E2B pause/resume. Pause when no bot has a running computer
  task, no sub-agent is running and no viewer is open for N minutes (default
  15). Resume on a computer tool call, a sub-agent start, a 唤醒 press or a
  viewer open.
- **Thread machines:** pause and resume on their own, as above.

### The daemon

The daemon handles Mikka registration and task lifecycle traffic through
`packages/protocol/src/device.ts`. Cloud devices register with `kind: "cloud"`
and stay out of the personal device picker. Official native CLIs connect
directly to their model providers with the selected authentication.

### Secrets

The E2B API key is the run owner's own key, stored per person (`user_e2b_keys`;
[conflicts](research/2026-10-31-orchestration-conflicts.md) C21). Every E2B call
resolves the sandbox's owner from its machine record, never the person asking. A
key saved for a workspace before keys were personal is adopted by whoever saved
it on first use. There is no platform key in production
([hosted abuse controls](../backend/hosted-abuse-controls.md)).
The server reads it; it is never handed to the model or to the sandbox. A
platform `E2B_API_KEY` exists only for isolated acceptance.

### Licensing (hard rule)

Only the MIT `cua-driver-rs` (pinned v0.38.0, as in #161) may be used. Do not
use, copy, bundle or connect to `cua-spacesd`, Cua Spaces, `trycua/*` images or
`cua-perception` / OmniParser: they are FSL-licensed or out of scope. Use the
official-derived E2B template selected for the task and add Mikka software under `/opt/mikka`, preserving original files under the
[template decision](decisions/2026-11-03-1430-official-e2b-templates-unchanged.md).

### Reuse from #161

Reuse, don't rewrite:

- `packages/daemon/src/computer/driver.mjs`: driver detection, pinned version,
  binary fingerprint, call normalization.
- `packages/daemon/src/computer/broker.mjs`: the request-only MCP proxy and the
  exact-operation approval wait.
- `packages/protocol/src/computer.ts`: the request and decision schemas.
- The web review ledger (`local_computer_reviews` migration, `/devices/approvals`
  flow): owner, run, expiry and digest binding.

New on top of #161:

- A display is chosen per call.
- The cloud device kind.
- The "allow for this run" scope.
- Wake, sleep, viewer and control.

## 3. Verify before building

1. **Per-display driving.** `executeDriver` spawns `cua-driver mcp --direct` per
   call and passes `DISPLAY` through from the daemon env (`driver.mjs`). Spawn it
   with `DISPLAY=:N` for the bot's display. Then prove the following with two
   concurrent Xvfb displays, extending `xvfb.test.mjs`:
   - Screenshots and clicks land on the right display.
   - Nothing leaks between the two displays.
2. **Pause/resume.** Check whether E2B pause/resume keeps the Xvfb and VNC
   processes and Chrome alive. If it does not, define a cheap restore on resume.
3. **Viewer auth.** The noVNC endpoint is reachable through the sandbox's public
   host. It must require a short-lived signed token, with separate view and
   control grants, and must never be open by URL alone.
4. **Session reuse.** Check authorized same-owner reuse while two Chromes run,
   and prove that sessions cannot cross account-owner boundaries.

Report findings in the issue before building on an assumption that failed.

## 4. Data model (proposal)

- `cloud_machines`: workspaceId, ownerId (primary key: one per person per workspace), sandboxId, deviceId, state
  (`sleeping | waking | running | error`), lastActiveAt.
- `bot_desktops`: workspaceId, botId (references `bots.id`; unique pair), display number, control
  (`agent | user | idle`), controlledBy (userId, nullable), lastActiveAt.
- `thread_machines`: runId (unique), sandboxId, snapshotId, state
  (`starting | running | paused | ended | error`), desktop (boolean),
  lastActiveAt.
- `bot_subagents`: id, workspaceId, botId, task (one sentence, R-45), state
  (`queued | running | needs_you | done | failed | stopped`), step (the
  current step line), needs (`login` with site and account, or null), browser
  context id, createdAt, endedAt. No credential column.
- Saved logins: the #180 vault, keyed by user account and site
  (`credential-vault.md`); only ciphertext is stored.
- Approval rows: reuse the #161 ledger. Add `scope: once | run` so that
  本任务内都允许 auto-approves later operations of the same run on the same
  desktop. A workspace `deny` still wins.

Additive migrations only, tested against a real Postgres; see `docs/migration-bootstrap.md` for when they run.

## 5. API contract for the frontend

All browser routes are session-authenticated and same-origin, scoped to the
active workspace. Shapes are zod schemas in `packages/protocol`, so both sides
import them.

### Computer state

`GET /api/bots/:botId/computer`

```ts
{
  machine: "sleeping" | "waking" | "running" | "error"
  control: "agent" | "user" | "idle"   // who drives this bot's desktop now
  controlledBy?: { userId: string }    // when control === "user"
  lastAction?: { tool: "click" | "type" | "key" | "scroll", x?: number, y?: number,
                 rect?: { x: number, y: number, w: number, h: number }, at: string }
  pendingApproval?: ApprovalView       // see below
}
```

The frontend draws the blue target ring and cursor from `lastAction`, in screen
coordinates of a fixed 1280×800 desktop, and the orange ring from
`pendingApproval`.

`POST /api/bots/:botId/computer/wake` returns `202` and drives
`machine: waking → running`.

### Live view

`POST /api/bots/:botId/computer/viewer` with body `{ mode: "view" | "control" }`
returns:

```ts
{ url: string, expiresAt: string }
```

The `url` is a noVNC WebSocket URL with an embedded short-lived token. `control`
is only granted while the caller holds control (see takeover). The details page
thumbnail, the chat card and the full-window viewer all use `view`.

### Takeover

- `POST /api/bots/:botId/computer/takeover` sets `control: "user"`. It holds
  only work on the Bot's own desktop, and returns a control viewer URL. Every
  thread runs on its own machine (decision
  [0251](decisions/2026-11-02-0251-desktop-runs-get-their-own-machine.md)), so
  a takeover pauses no thread and a thread's claim does not wait for it.
- `POST /api/bots/:botId/computer/handback` sets `control: "agent"` and
  releases the Bot desktop takeover. Task machines retain their own lifecycle.
- Only one user can hold control at a time. A second takeover gets `409` with
  `controlledBy`.

### Approvals

```ts
type ApprovalView = {
  id: string, digest: string, runId: string, botId: string,
  action: { tool: "click" | "type" | "key" | "scroll", x?: number, y?: number, text?: string },
  summary: string,     // e.g. 点击「登录」 — short, from the operation, no screenshot
  expiresAt: string,
}
```

`POST /api/computer/approvals/:id` with body
`{ digest, decision: "approve" | "deny", scope: "once" | "run" }`. This keeps
#161's guarantees: the digest must match, the request expires and cannot be
replayed, and the response says "queued", never an invented success.

### Events

The UI needs push, not polling. Emit these as run events (AI SDK
`UIMessageChunk` data parts on the existing `/v1/runs/:runId/events` path) so
that they land in the conversation:

- `data-computer` with `{ botId, runId, task: string, state: "working" | "approval" | "done" | "failed", approvalId? }`.
  This is one card per computer task. `task` is the one-sentence task shown on
  the card.
- `data-subagent` with `{ botId, subagentId, task: string, state: "queued" | "running" | "needs_you" | "done" | "failed" | "stopped", step?: string, needs?: { kind: "login" | "code", site: string, account?: string } }`
  on the bot's chat (not a run). This is one card per web task, with a live
  view from `POST /api/bots/:botId/subagents/:id/viewer` (same shape as the
  computer viewer, view only). `POST /api/bots/:botId/subagents/:id/credentials`
  fills a login (above) and `POST /api/bots/:botId/subagents/:id/stop` stops it. The
  bot then reports the outcome as an ordinary chat message.

Workspace-level state changes use the existing scoped live invalidation
channel (`hooks/use-live-key.tsx`, `lib/live/`). A visible idle page reads only
after an invalidation. The original proposed event categories were

- `computer.machine`: `{ state }`
- `computer.control`: `{ botId, control, controlledBy? }`
- `computer.action`: `{ botId, lastAction }`, throttled to at most 4/s
- `computer.approval`: `{ botId, approval | null }`

### Add device (user's own machines)

The 添加设备 flow already exists server-side: `POST /api/devices/ssh` streams the
`login | check | install | start | connect` steps the dialog shows. Two gaps:

1. **Host list.** The dialog lists the user's SSH config hosts and Tailnet
   machines. The server, running on Vercel, cannot see either. The user's local
   daemon reports them:
   - Add a field to its heartbeat:
     `knownHosts: { alias, hostName?, source: "ssh" | "tailnet", configured: boolean }[]`.
   - Sources: `~/.ssh/config` and `tailscale status --json`.
   - Expose the list as `GET /api/devices/hosts`.

   With no local daemon, the list is empty and the user types a host.
2. **Who runs ssh.** Vercel has no `ssh`. Run the install over the user's local
   daemon (a new daemon command), streaming the same step events back. Keep the
   server-side path only for self-hosted deployments.

`GET /api/devices` must exclude `kind: "cloud"` devices.

## 6. Not in scope for the backend

All UI (details page, chat card, viewer, dialogs), copy and styling. Those follow
the Figma section above and are built in a separate frontend thread once
section 5 is settled.

## 7. Open questions for the backend owner

- E2B plan limits: pause duration, disk size, concurrent displays per sandbox,
  and CPU/RAM per sandbox size.
- Whether Chrome should keep running across pause, or restart with the session
  restored.
- Default idle timeout before pause (proposal: 15 minutes).
- Thread machine size and snapshot refresh: what triggers a new workspace
  snapshot (lockfile change, schedule), and how long a cold start takes.
- Sub-agent cap per workspace (proposal: 6) and how many headless contexts one
  bot machine size can hold.

## 8. Task-machine implementation

`lib/cloud-computer/thread-machines.ts` binds a machine to its owner, workspace,
Bot context, task and admitted repository. `ensureThreadMachine` selects a
verified template for new work and adopts only the same task's eligible
retained machine. The task's own E2B key is required. A parent Bot snapshot is
not a prerequisite.

Claim accepts only the dedicated cloud device for that binding. Computer
policy applies to computer work, with repository-only work retaining its
existing authorization. A Bot desktop takeover cannot pause another task's
claim or execution.

When a run ends, the lifecycle can pause and retain an open task's machine.
Task closure retires it after native-exit and ownership checks. If the provider
has lost the sandbox, recovery recreates it from its verified template and
uses the task's persisted branch/checkpoint. A failed wake with a retained
filesystem reports that failure instead of discarding the task's state.
Running compute intervals are tracked separately from paused time.

Cloud availability uses `cloudComputerRunsEnabled()` and the deployment
switches in `lib/deployment-switches.ts`. Disabling cloud execution refuses new
cloud work through those gates. It does not authorize claiming a queued task
on the Bot's desktop. Existing machine stop, pause and retirement paths still
own cleanup.

Placement and fallback follow [orchestration](orchestration.md) and
[model-order dispatch](decisions/2026-11-02-1400-model-order-dispatch.md). An
explicit destination stays pinned. Defaults resolve cloud, then eligible
servers, then computers through the existing dispatcher. Preserve each run's
frozen model, Agent and credential selection throughout recovery.

For acceptance, record the fixed source, template/worker release, application,
database, task and sanitized run evidence under [acceptance.md](../acceptance.md).
Official Claude Code (`claude-haiku-5-5`) and Codex (`gpt-6-luna`) subscription
paths have independent results. API-key execution does not gate acceptance.
