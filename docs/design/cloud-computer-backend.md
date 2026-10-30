# Cloud computer: backend handoff

Owner split (Alex, 2026-10-24): **Codex builds the backend described here; the
frontend is built separately** against the API contract in section 5. When the
design changes, this document is updated, not forked. Revised 2026-10-27:
separate thread machines and bot web sub-agents (section 2, R-72).

- Design review page: https://claude.ai/artifact/G8aEuFM4rwvGFeZbPYyVwU
- Figma: file `zPe5LKycb2XuT1ivCLRw07`, section "云端电脑" (node `102:65`)
- Related: #147 (computer use), #161 (local CUA driver, approvals), #157
  (remote desktop, superseded by this document)

## 1. What the user sees

Every bot has "its own computer" (its own desktop on the workspace's one cloud
machine), the way Grok Bot does it. Bot and thread are defined in
[glossary.md](glossary.md): the threads (runs) a bot starts use that bot's
computer. The computer is keyed by `bots.id`, never `agents.id`:

- **电脑 tab (right panel)**: the selected bot's existing `AgentComputer`
  view. The 概览 header shows the bot's avatar and name, not a screen caption
  (decision 2026-10-28, R-02).
- **Full-window viewer**: starts view-only (仅观看). 取得控制权 pauses the agent
  and gives the user mouse and keyboard (你在操作); 交还给 <Bot 名> hands control back.
- **Chat**: one 电脑 card per computer task. It shows the task sentence, a state
  (<Bot 名> 操作中 / 完成) and the live screen. The bot does not ask before
  acting (decisions 2026-10-30); the person takes control to stop it. There is
  no step list and no operation log anywhere.
- **Sleep**: the computer sleeps when idle and keeps its disk. It wakes
  automatically when an agent needs it, or when the user presses 唤醒.
- **设置 › 设备** lists only machines the user connected (this Mac, SSH hosts,
  Tailnet machines). The cloud computer is our infrastructure: it is never
  listed there and cannot be created by the user.
- **添加设备**: a host field plus the hosts found in the user's `~/.ssh/config`
  and on their Tailnet; 设置 then shows progress through 登录 → 检查主机 →
  安装 Mikka → 启动服务 → 连接.

## 2. Architecture

Revised 2026-10-27 (Alex; `decisions.md`, R-72). The 2026-10-24 version put
every bot and every cloud thread on one machine per workspace. Threads build,
install and test, which is heavy, so they now get machines of their own, as in
Cursor's cloud agents, Devin, Codex cloud and Copilot's coding agent. Bots stay
on one shared machine, as in Grok Bot.

```
workspace ──1:1── bot machine (E2B sandbox, Linux)          light, shared
                    ├─ mikka daemon (device, kind = "cloud")
                    ├─ owner-scoped authentication (never shared across users)
                    ├─ bot A: Xvfb :1 + WM + x11vnc + websockify → noVNC
                    │         Chrome profile ~/.mikka/profiles/<botId>
                    ├─ bot A, web sub-agents: one headless Chrome each,
                    │         live view by CDP screencast
                    ├─ bot B: Xvfb :2 + …
                    └─ cookie sync between one owner's profiles only

cloud thread ──1:1── thread machine (E2B sandbox from the workspace snapshot)
                    ├─ mikka daemon running the coding harness (Claude Code, Codex)
                    ├─ /workspace: the repo at the thread's branch
                    └─ desktop (Xvfb + WM + VNC + Chrome) only when needed
```

### Bot machine (one per workspace)

- **Shared:** all bots and their web sub-agents. The load is light: chat turns
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

### Thread machine (one per cloud thread)

- **One E2B sandbox per thread**, so threads never slow each other down or the
  bots.
- **Start:** from a workspace snapshot that holds the repo, dependencies and
  the coding CLI logins, so it boots in seconds. The thread then checks out its
  branch. Refresh the snapshot when dependencies change.
- **Lifecycle:** pause while idle (no charge), resume on the next step, kill
  when the thread ends. A thread's changes live on its branch; nothing is
  copied back to the bot machine.
- **Desktop on demand:** a thread that needs a screen, for example to accept a
  web change, starts Xvfb, the WM, VNC and Chrome on its own machine. It never
  moves to another machine, so no data is transferred.
- **Threads on the person's own devices** (their Mac, SSH hosts) are
  unchanged. They cannot see cloud screens; their acceptance runs on that
  device.

### Seeing and driving across machines

- **On the same machine:** any process can use a display (`DISPLAY=:N`), and
  any agent can drive a Chrome through its CDP port.
- **Across machines:** a bot views a thread's screen, or drives its browser,
  through a port the thread machine exposes (E2B public host). The thread
  reaches the bot machine the same way. Every such port needs a short-lived
  signed token, with separate view and control grants, as for the noVNC viewer.
- **One driver per screen:** control is `agent | user | idle` plus the holder
  (bot, sub-agent, thread or person). A second driver waits; it does not fail.

### Sleep

- **Bot machine:** E2B pause/resume. Pause when no bot has a running computer
  task, no sub-agent is running and no viewer is open for N minutes (default
  15). Resume on a computer tool call, a sub-agent start, a 唤醒 press or a
  viewer open.
- **Thread machines:** pause and resume on their own, as above.

### The daemon

The daemon is the only thing that talks to our server, exactly like a local
device (ADR 0016 link, `packages/protocol/src/device.ts`). On each machine it
registers with `kind: "cloud"`, so the devices UI can exclude it.

### Secrets

The E2B API key is `E2B_API_KEY`. Alex adds it to Infisical in `prod:/vercel`
and in `dev`. None of the existing keys covers E2B. Read it from the
environment only; never hand it to the model or to the sandbox.

### Licensing (hard rule)

Only the MIT `cua-driver-rs` (pinned v0.38.0, as in #161) may be used. Do not
use, copy, bundle or connect to `cua-spacesd`, Cua Spaces, `trycua/*` images or
`cua-perception` / OmniParser: they are FSL-licensed or out of scope. Build the
image from a plain Linux base (Xvfb, a light WM, x11vnc, websockify, noVNC,
Chrome, the mikka daemon, the driver).

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

- `cloud_machines`: workspaceId (unique), sandboxId, deviceId, state
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

- `POST /api/bots/:botId/computer/takeover` sets `control: "user"`. It pauses
  the bot's computer tool calls, which wait and do not fail, and returns a
  control viewer URL.
- `POST /api/bots/:botId/computer/handback` sets `control: "agent"`. Waiting
  tool calls resume.
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

Workspace-level state changes also need to reach the details page outside a
run. The app has no realtime channel yet, so add one: an SSE stream at
`GET /api/computer/events`. Polling `GET .../computer` every 2 s is an
acceptable first step. The stream carries:

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

## 8. Enabling per-thread machines

Off by default. The code path needs one flag and one provider key; nothing
provisions a machine without both.

Prerequisites:

1. `E2B_API_KEY` is set for the worker deployment.
2. `20261029011635_subagents_thread_machines.sql` and
   `20261029080001_owner_cloud_machines.sql` are applied to the matching
   database.
3. A workspace cloud machine exists for the owner, because every thread machine
   starts from its workspace snapshot.

Enable with `MIKKA_CLOUD_THREAD_MACHINES=1`. Enqueue then writes one
`thread_machines` row in `starting`, and `claimCloudRun` accepts the run only
from that dedicated cloud device.

Cost boundaries: one machine per cloud thread; idle pause after 15 minutes, with
the provider timeout refreshed only while the run is active; a hard end after 12
hours, a terminal run state, or an explicit `end`.

E2B bills per second only while a sandbox is running: "You only pay while a
sandbox is actively running. Once a sandbox is paused, killed or times out,
billing stops immediately." Storage is included, and a paused sandbox is kept
indefinitely, so a paused machine costs nothing and counts only against state,
never against the compute budget.

`ensureThreadMachine` enforces hard spend guards before any provider call. The
workspace and owner advisory locks make the count race-free, so two provisioning
runs cannot both take the last slot:

| Setting | Default | Blocks |
| --- | --- | --- |
| `MIKKA_THREAD_MACHINES_PER_OWNER` | `3` | A 4th running machine for one owner |
| `MIKKA_THREAD_MACHINES_PER_WORKSPACE` | `20` | A 21st running machine in one workspace |
| `MIKKA_THREAD_MACHINE_MONTHLY_COMPUTE_HOURS` | `60` | The owner's rolling 30-day E2B-billed compute hours |

A blocked request returns `429` (`Thread machine limit reached`, `Workspace
machine limit reached`, or `Thread machine budget exhausted`); it never
provisions or bills. Invalid, zero or negative settings fall back to the
defaults, so there is no "unlimited" configuration.

Compute hours are tracked, not assumed: the migration adds `runningSince` and
`computeSeconds` to `thread_machines`. Provisioning sets `runningSince`; a
provider auto-pause detected on resume, a manual pause and an end accumulate the
elapsed running interval and clear `runningSince`, so paused time is never
counted. The budget sums `computeSeconds` plus any interval still running.

The defaults follow comparable products, adjusted for the 2 vCPU shape: Cursor
Pro runs up to 8 concurrent Cloud Agents per account, so one owner gets 3;
GitHub Codespaces grants free accounts 120 core-hours a month (60 real hours on
a 2-core machine) and a 12-hour maximum lifetime, which matches the 60-hour
budget and the 12-hour end; E2B enforces concurrent running sandboxes per team,
and 20 stays inside the Hobby ceiling.

Disable by draining first. The flag is read at enqueue and at claim, so turning
it off while a thread run is still queued sends that run down the Bot-machine
claim path instead. Let queued thread runs finish or stop them, end their
machines, then unset the flag. Machines left running keep billing until the
lifecycle workflow ends them.

