# Cloud computer: backend handoff

Owner split (Alex, 2026-10-24): **Codex builds the backend described here; the
frontend is built separately** against the API contract in section 5. When the
design changes, this document is updated, not forked.

Updated 2026-10-24 against the current [issue #172](https://github.com/alexj11324/Mikka/issues/172).
Both Mikka's own harness and hosted official Codex / Claude Code must use
connected subscriptions and be able to operate E2B terminal, browser and CUA
tools. Compute, model authorization and execution harness are independent axes.
The Mikka harness may run outside E2B and call its authorized tools remotely.

**Delivery status:** routing/refusal policy and model/native-adapter seams are
implemented. A pinned CPA worker/store now implements SDK acquisition/refresh,
canonical credential hydration, Infisical v4 publication and Postgres fencing,
tested with synthetic grants and HTTP fakes. Live providers/connect UI remain
unregistered. No real account was connected or secret configured, and no E2B
machine was provisioned. The viewer APIs below remain a target, not shipped APIs.

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
                    ├─ shared:  /workspace (repos, files)
                    ├─ owner-scoped CLI auth / browser session compartments
                    ├─ bot A:   Xvfb :1 + WM + x11vnc + websockify  → noVNC
                    │           Chrome profile ~/.mikka/profiles/<agentId>
                    ├─ bot B:   Xvfb :2 + …
                    └─ authorized same-owner session reuse only
```

- **One machine per workspace**, not one per bot. The cost is one sandbox's
  running time plus one disk.
- **Shared files**: bots may share project files under `/workspace`. They must
  not share cross-user `$HOME`, CLI auth state, browser cookies or refresh
  credentials. Separate config directories under one unrestricted uid do not
  isolate credentials from shell tools. Multiple credential owners cannot be
  enabled until a real process/sandbox boundary has passed isolation tests.
- **Topology decision still open**: retain one workspace machine as the product
  target. A separate E2B sandbox per workspace/account owner is a proposal for
  security and cost review, not an approved replacement. Neither topology is
  implemented by this slice. Per-bot desktops and shared projects are preserved.
- **Isolated desktops**: each bot gets its own X display (`Xvfb :N`), window
  manager, apps and windows, and its own VNC stream. Displays are allocated
  lazily on a bot's first computer use and kept across sleep.
- **Browser sessions**: each bot keeps its own profile. Session reuse must be
  explicitly authorized for the same account owner; never automatically sync
  cookies between users. Validate concurrent-profile behavior before choosing
  an implementation. Provider CLI authentication is separate from browser cookies.
- **Sleep**: use E2B pause/resume. Pause when no bot has a running computer
  task and no viewer is open for N minutes (default 15). Resume on a computer
  tool call, a 唤醒 press or a viewer open.
- **The daemon is the only thing that talks to our server**, exactly like a
  local device (ADR 0016 link, `packages/protocol/src/device.ts`). It registers
  with `kind: "cloud"` so the devices UI can exclude it.

### Secrets

The E2B API key is `E2B_API_KEY`. Alex reports it has been added to Infisical.
Only the control plane reads it from workload-injected configuration; never
hand it to a model, agent sandbox, task environment, or logs. This phase did
not read it or test delivery. Presence of the key does not authorize metered
provisioning, connector creation or subscription sign-in.

CPA is the requested subscription credential acquisition/refresh adapter;
Infisical is the preferred existing managed storage candidate. Native CLI
state needs its own compatibility bridge. Keep credential custody abstract;
do not build a general-purpose vault or substitute a generic OAuth service.
See [CPA credential lifecycle and Infisical design](byos-cpa-credentials.md).

### Licensing (hard rule)

Only the MIT `cua-driver-rs` (pinned v0.38.0, as in #161) may be used. Do not
use, copy, bundle or connect to `cua-spacesd`, Cua Spaces, `trycua/*` images or
`cua-perception` / OmniParser: they are FSL-licensed or out of scope. Build the
image from a plain Linux base (Xvfb, a light WM, x11vnc, websockify, noVNC,
Chrome, the mikka daemon, the driver).

### Reuse from #161

Reuse, don't rewrite:

These #161 paths are referenced by the handoff, but are **absent from main
`7d7a345`**. Integrate their reviewed implementation when available; this slice
does not invent or copy an alternative driver/approval system.

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
4. **Session reuse.** Verify authorized same-owner reuse with two Chromes and
   prove that neither session nor credentials cross an account-owner boundary.

Report findings in the issue before building on an assumption that failed.

## 4. Data model (proposal)

The computer/desktop tables below remain proposals. The separate additive
`20261024064200_byos_credential_publications.sql` migration introduces only
`byos_connections` ownership/state/epoch/version/secret-reference/publication
metadata. Credential values are never stored in this table. It is tested on
isolated real Postgres; no production schema or secret was changed.

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

## 8. BYOS account and route design

The user connects an OpenAI or Anthropic account once. Normal tasks, worker
restarts and supported E2B sleep/resume reuse the saved connection. Login is
not a per-run operation. A provider may require distinct initial consent for
direct-model access and native CLI use; one account in Mikka can retain both
grants, without pretending they are interchangeable tokens.

`subscriptionConnectionSchema` stores only metadata: Mikka owner, workspace,
provider, connection state and revision, and quota numbers. A binding explicitly
names the consumer (bot or assistant session), connection revision and route.
The server derives owner/workspace/consumer from its authorized session/run.
Neither the model nor request body can select another user's account, endpoint
or credential. Workspace membership alone grants no subscription access.

| Route | Existing execution seam | Current capability / release gate |
| --- | --- | --- |
| `codex_cli` | `CodexAdapter`, official app-server | Optional host-managed token login/refresh bridge implemented and fake-tested; CPA audience, pinned CLI and isolated runner remain unverified |
| `claude_code_cli` | `ClaudeAdapter`, Agent SDK bundled CLI | Optional access-lease broker mode, first-party/no-API-key mode check and expiry stop implemented/fake-tested; real CPA token scopes/native acceptance and isolated runner remain unverified |
| `codex_cpa` | Mikka's existing AI SDK `streamText` loop | CPA-acquired Codex grant, owner-scoped executor/broker; implementation, transport and provider release gates remain |
| `claude_cpa` | Same AI SDK model seam | CPA-acquired Claude grant, owner-scoped executor/broker; implementation, transport and provider release gates remain |
| `openai_siwc` | Optional separate AI SDK model route | Public SIWC direct plan access exists; Mikka's remote/paid admission unestablished; does not replace the CPA route |

For CPA-hosted credentials, the optional daemon bridge uses experimental
`account/login/start` (`chatgptAuthTokens`) and
`account/chatgptAuthTokens/refresh`. A trusted owner-bound broker supplies only
access material; the CPA worker retains refresh authority. This bridge is
offline-tested against a fake app-server, not registered in the production
launcher. Native managed `chatgpt` / `chatgptDeviceCode` login is a separate
integration option, not an automatic fallback. Use `account/read`,
`account/logout`, and `account/rateLimits/read` only through a verified account
adapter. Do not repurpose arbitrary native Codex tokens as
SIWC credentials. SIWC needs `chatgpt.tokens.use.direct`, validated identity and
grant scopes, `store:false`, `stream:true`, and an eligible registered client.
A model list is not an entitlement check.

Provider evidence checked on 2026-10-24:
[Codex managed auth](https://learn.chatgpt.com/docs/app-server#authentication),
[SIWC plan access](https://developers.openai.com/siwc/token-sharing-open-source),
[SIWC limits](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations),
[Claude SDK plan support](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan),
[hosted Claude Code rules](https://code.claude.com/docs/en/legal-and-compliance).
Subscription support and third-party credential custody are separate questions.

The policy refuses missing or mismatched owner/workspace/consumer bindings,
old revisions, pending/disconnected/reconnect-required connections, unavailable
backends, unverified runtime boundaries/billing, and unknown or exhausted quota.
It reuses the daemon's quota schema; malformed, empty, wrong-vendor, future or
older-than-60s observations remain unknown. This is intentionally conservative:
providers without an appropriate quota adapter remain unavailable. Do not reuse
a native Codex quota answer as proof of a separate SIWC entitlement.

Reconnect increments the revision and clears quota. Rebinding after verified
reauthorization is a server action that must compare the provider's stable
account identity; email alone is insufficient. Only one authority may refresh
a rotating grant; fence its private credential version before saving. Ordinary
refresh preserves the connection authorization epoch and bot bindings. Transient
provider errors do not automatically erase the account or force login. Native
CLI-managed grants remain CLI-managed, with no second refresh writer.
CPA-acquired bundles instead use CPA's refresh lifecycle with an owner-scoped
custom Store; no generic OAuth SaaS is substituted for CPA. A tested native
projection or a separate native grant is required to consume them through an
official CLI. Never copy CPA JSON directly or rotate one grant in both CPA and
the CLI concurrently. These compatibility/ownership choices remain deferred.

Disconnect first denies new uses and invalidates platform leases, then cancels
active runs, clears cached access and calls the supported provider/native logout
operation. Report provider revocation limitations. The pure invalidation helper
implements protocol metadata transitions only. The worker now provides durable
refresh serialization and publication fencing. Active-run cancellation,
provider logout/revocation and historical secret cleanup are deferred.

`resolveSubscriptionModel` checks the binding before constructing the AI SDK
model and again before each model call/tool step. `startSubscriptionSession`
checks before resolving the native adapter and before starting it, rejects
polluted credential environments, and cancels/refuses later interjections if
access has been revoked. Its backend descriptors are trusted runner inputs,
not security isolation implemented by a TypeScript flag. Arbitrary native
session continuation is refused until an owner/revision/session ledger exists;
this does not require a new provider login for each new task.

`POST /api/agent` accepts an optional explicit
`modelSource: {type:"subscription", bindingId:"<uuid>"}`. The production BYOS
factory is deliberately unregistered, so that selection returns HTTP 409 with
`backend_unavailable` before reading a paid-provider key or persisting a turn.
Existing default-model requests retain their current behavior. No fallback to
API billing or another account is permitted after a BYOS selection.

The live consumer-to-source preference still needs durable server-side storage:
once a bot/session selects BYOS, subsequent tasks must resolve that binding
automatically. Omitting a browser field must not revert a saved BYOS preference
to the paid default. This foundation exposes no connection/selection UI and
does not persist such preferences or register a production backend.

The shared E2B tool plane must authorize owner, workspace, bot, desktop and run
independently of model selection. Both harnesses use the same reviewed #161
approval ledger; per-bot Playwright MCP and CUA grants cannot be elevated by
selecting a subscription. Neither computer tools nor that integration are
implemented in this foundation.

## 9. Reference implementation review

[Comma's adapter at `ddcdcc5`](https://github.com/AFK-surf/Comma/blob/ddcdcc5bd49620cefa623da2f38b98e72a7b613e/systems/account-proxy/README.md)
separates Salix's tenant account ownership, encrypted persistence, refresh and
quota selection from a stdio Go worker running CPA executors. Its
[bootstrap](https://github.com/AFK-surf/Comma/blob/ddcdcc5bd49620cefa623da2f38b98e72a7b613e/systems/account-proxy/bootstrap.sh)
pins CPA to `d33f63f8e3d98428440ebca5a5b6a981a61ff71e`. Native coding CLI
launch in `systems/station/src/agents/claude.ts` is a separate execution path.
[CPA at `8289ec4`](https://github.com/router-for-me/CLIProxyAPI/tree/8289ec4c71ad914d0612c2776352b76ba3d355a6)
handles OAuth credentials and direct upstream inference; this does not mean
inference is performed by official hosted CLIs or approved for every platform.

License review: [Comma root is AGPL-3.0](https://github.com/AFK-surf/Comma/blob/ddcdcc5bd49620cefa623da2f38b98e72a7b613e/LICENSE);
[CPA root is MIT](https://github.com/router-for-me/CLIProxyAPI/blob/8289ec4c71ad914d0612c2776352b76ba3d355a6/LICENSE).
The worker depends on the pinned CPA SDK and preserves its MIT license. Comma
source is not copied. Only actual CPA lifecycle/store interfaces and credential
data/patch types are used; built-in model executors and fingerprint/cloaking
transports are not registered or executed. No account pooling to evade limits
is implemented. These licenses do not grant provider subscription rights.

## 10. Next authorized acceptance gates

Synthetic tests exercise repeated model tasks on one connection, both native
adapters using fake CLIs, ownership/refusal policy, revocation and clean child
environments. The CPA worker additionally exercises actual SDK managers with
TLS fixture acquisition/rotation/inference, immutable Infisical HTTP publication,
real Postgres concurrency/faults, restart recovery and a private subprocess.
Optional Codex and Claude native broker modes are tested with fake CLI processes;
the latter ends at access expiry because its SDK lacks a documented host refresh
callback. The CPA worker retains the sole rotating grant in both modes. Launcher
registration/private broker delivery are still deferred, as is transparent
Claude session continuation after an expiry stop.
These prove the implemented adapter boundary against fakes; real provider OAuth,
Infisical deployment, subscription inference, native token compatibility and E2B
isolation/restart/sleep survival remain explicit gates. Run the reproducible
Linux acceptance with `pnpm test:byos-worker`.

Repository drift: this implementation began at main `7d7a345fc5801c34e9d664dff1c9dd7556448fc2`.
Main later advanced to `5a0e1c411f487fee433c48414f7130d0d58dad92` via documentation
PR #173. Its shared-HOME/login assertions conflict with the updated #172 owner
requirements. This branch preserves the corrected ownership sections; a future
merge must keep those corrections rather than restore shared credentials.

Before any real E2B validation, obtain separate authorization for this bounded
proposal: one existing standard sandbox template, default 2 vCPU / 4 GiB,
at most 300 seconds before pause plus 300 seconds after resume, no custom
template build, subscription login, provider calls or plan upgrades. Operations:
create once, run a synthetic terminal/process/sentinel test, pause once, resume
the same sandbox once with a 300s timeout, inspect sentinel/process survival,
and kill in cleanup. Do not retry creation automatically. This tests lifecycle
only, not Xvfb/noVNC/CUA or credentials.

At the [published E2B rates](https://e2b.dev/pricing) checked 2026-10-24, CPU
and RAM total $0.000046/s, so 600 aggregate running seconds estimate $0.0276
in compute. Proposed authorization cap: $0.05 with no new recurring plan or
paid add-on. Verify template sizing, timeout behavior, storage/other charges and
the account's applicable rates before executing; stop if that cap cannot be
established. No sandbox or secret was created for this proposal. Real credential
and egress-injection tests require their own explicit operation/cost scope.
