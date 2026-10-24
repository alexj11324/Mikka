# Cloud computer: backend handoff

Owner split (Alex, 2026-10-24): **Codex builds the backend described here; the
frontend is built separately** against the API contract in section 5. When the
design changes, this document is updated, not forked.

- Design review page: https://claude.ai/artifact/G8aEuFM4rwvGFeZbPYyVwU
- Figma: file `zPe5LKycb2XuT1ivCLRw07`, section "云端电脑" (node `102:65`)
- Related: #147 (computer use), #161 (local CUA driver, approvals), #157
  (remote desktop, superseded by this document)

## 1. What the user sees

Every bot (agent) has "its own computer", the way Grok Bot does it:

- **Agent 详情页**: the bot's live screen ("Mikka Frontend 的屏幕") with a state
  badge. A centered 打开 button opens a full-window viewer.
- **Full-window viewer**: starts view-only (仅观看). 取得控制权 pauses the agent
  and gives the user mouse and keyboard (你在操作); 交还给 Agent hands control back.
- **Chat**: one 电脑 card per computer task. It shows the task sentence, a state
  (Agent 操作中 / 等你审批 / 完成) and the live screen. Approval happens inside
  the card (允许 / 拒绝 / 本任务内都允许). There is no step list and no operation
  log anywhere.
- **Sleep**: the computer sleeps when idle and keeps its disk. It wakes
  automatically when an agent needs it, or when the user presses 唤醒.
- **设置 › 设备** lists only machines the user connected (this Mac, SSH hosts,
  Tailnet machines). The cloud computer is our infrastructure: it is never
  listed there and cannot be created by the user.
- **添加设备**: a host field plus the hosts found in the user's `~/.ssh/config`
  and on their Tailnet; 设置 then shows progress through 登录 → 检查主机 →
  安装 Mikka → 启动服务 → 连接.

## 2. Architecture

```
workspace ──1:1── cloud machine (E2B sandbox, Linux)
                    ├─ mikka daemon (registered as a device, kind = "cloud")
                    ├─ shared:  /workspace (repos, files)   $HOME (CLI logins)
                    ├─ bot A:   Xvfb :1 + WM + x11vnc + websockify  → noVNC
                    │           Chrome profile ~/.mikka/profiles/<agentId>
                    ├─ bot B:   Xvfb :2 + …
                    └─ cookie sync between the bot profiles
```

- **One machine per workspace**, not one per bot. The cost is one sandbox's
  running time plus one disk.
- **Shared files**: all bots work in the same `/workspace` and the same
  `$HOME`. Claude Code / Codex CLI logins (stored under `$HOME`) are therefore
  done once and work for every bot.
- **Isolated desktops**: each bot gets its own X display (`Xvfb :N`), window
  manager, apps and windows, and its own VNC stream. Displays are allocated
  lazily on a bot's first computer use and kept across sleep.
- **Browser logins are shared**: Chrome locks a profile directory to one
  process, so each bot gets its own profile. A background job syncs cookies
  between profiles, for example with CDP `Network.getAllCookies` and
  `Network.setCookies`. Logging in on one bot's desktop then logs every bot in.
  Sites that pin a session to one device may still ask again; that is accepted.
- **Sleep**: use E2B pause/resume. Pause when no bot has a running computer
  task and no viewer is open for N minutes (default 15). Resume on a computer
  tool call, a 唤醒 press or a viewer open.
- **The daemon is the only thing that talks to our server**, exactly like a
  local device (ADR 0016 link, `packages/protocol/src/device.ts`). It registers
  with `kind: "cloud"` so the devices UI can exclude it.

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
4. **Cookie sync.** Check that the CDP sync is reliable while two Chromes run.
   Measure how long a change takes to propagate.

Report findings in the issue before building on an assumption that failed.

## 4. Data model (proposal)

- `cloud_machines`: workspaceId (unique), sandboxId, deviceId, state
  (`sleeping | waking | running | error`), lastActiveAt.
- `bot_desktops`: workspaceId, agentId (unique pair), display number, control
  (`agent | user | idle`), controlledBy (userId, nullable), lastActiveAt.
- Approval rows: reuse the #161 ledger. Add `scope: once | run` so that
  本任务内都允许 auto-approves later operations of the same run on the same
  desktop. A workspace `deny` still wins.

Additive migrations only. They run automatically on Neon prod builds
(`scripts/migrate.mjs`), so test them against a real Postgres.

## 5. API contract for the frontend

All browser routes are session-authenticated and same-origin, scoped to the
active workspace. Shapes are zod schemas in `packages/protocol`, so both sides
import them.

### Computer state

`GET /api/agents/:agentId/computer`

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

`POST /api/agents/:agentId/computer/wake` returns `202` and drives
`machine: waking → running`.

### Live view

`POST /api/agents/:agentId/computer/viewer` with body `{ mode: "view" | "control" }`
returns:

```ts
{ url: string, expiresAt: string }
```

The `url` is a noVNC WebSocket URL with an embedded short-lived token. `control`
is only granted while the caller holds control (see takeover). The details page
thumbnail, the chat card and the full-window viewer all use `view`.

### Takeover

- `POST /api/agents/:agentId/computer/takeover` sets `control: "user"`. It pauses
  the bot's computer tool calls, which wait and do not fail, and returns a
  control viewer URL.
- `POST /api/agents/:agentId/computer/handback` sets `control: "agent"`. Waiting
  tool calls resume.
- Only one user can hold control at a time. A second takeover gets `409` with
  `controlledBy`.

### Approvals

```ts
type ApprovalView = {
  id: string, digest: string, runId: string, agentId: string,
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

- `data-computer` with `{ agentId, runId, task: string, state: "working" | "approval" | "done" | "failed", approvalId? }`.
  This is one card per computer task. `task` is the one-sentence task shown on
  the card.

Workspace-level state changes also need to reach the details page outside a
run. The app has no realtime channel yet, so add one: an SSE stream at
`GET /api/computer/events`. Polling `GET .../computer` every 2 s is an
acceptable first step. The stream carries:

- `computer.machine`: `{ state }`
- `computer.control`: `{ agentId, control, controlledBy? }`
- `computer.action`: `{ agentId, lastAction }`, throttled to at most 4/s
- `computer.approval`: `{ agentId, approval | null }`

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
