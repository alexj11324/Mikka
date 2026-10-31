# Orchestration conflicts (2026-10-31)

Where docs, decisions and code at `3b9c812` (main) disagree with
[`../orchestration.md`](../orchestration.md). Code rows name who should fix
them; doc rows marked **done** were aligned in the pull request that added the
spec. `decisions.md` is frozen: its rows are superseded by
[the decision](../decisions/2026-10-31-2300-orchestration-spec.md), not edited.

## Code

| # | Where | Today | Spec | Fix | Owner |
| --- | --- | --- | --- | --- | --- |
| C1 | `lib/workspace-access.ts:59-69` | A workspace is created only for a user with no membership; no `kind` | Every account has one personal workspace | `kind` column, lazy personal workspace | **#692** |
| C2 | `lib/execution-settings.ts:441-447`, `lib/subscription-repository.ts:10-23`, `lib/computer/bot-subscription.ts:21-23` | Connections and bindings looked up by (owner, workspace) | Subscriptions bound to the account | Look up by owner; clone the binding into the run's workspace | **#692** |
| C3 | `packages/protocol/src/subscription.ts:201-204`, `packages/subscription-worker/runtime_use.go:33` | A use is refused unless the connection's workspace equals the use's | Account-level, gated by share and admin switch | Owner + share/admin check | **#692** (Go `b."workspaceId"` dropped) |
| C4 | `lib/execution-settings.ts:595-634` (callers `lib/profile/extract.ts:35`, `lib/attention/score.ts:35`, `lib/suggestions/action-title-server.ts:39`, `lib/self-improvement/server.ts:39`, `lib/abuse/resolve.ts:11`) | Work with no workspace bills the oldest workspace | Personal workspace pays | `executionWorkspace(userId, null)` → personal | **#692** |
| C5 | — (no share table, no `allowOthers`) | Only the owner's own subscriptions exist | Per-workspace share, off by default; 「团队成员也可以用」 | Share row (owner, workspace, allowOthers) | New follow-up to #692 |
| C6 | `lib/bot-model-selection.ts:25-31` | Saved choice → owner's binding → hosted | + other members' shares with allowOthers, Claude first, before Mikka 默认 | Insert the share step | Follow-up to #692 (after C5) |
| C7 | `lib/subscription-model-snapshot.ts:81-143` | `switchAccount` swaps the account inside a running run on `quota_exhausted` | Never switch mid-run; stop | Drop the in-run switch (open question 5) | Follow-up to #692/#696 |
| C8 | `lib/subscription-repository.ts:30`, `lib/subscription-refusal.ts:5` | Throws `binding_required`, shown as unavailable | Never refuse for a missing subscription | Callers resolve to Mikka 默认 before reaching it | P0 resolver owner (#688 follow-up) |
| C9 | `packages/daemon/src/main.ts:403-407` | Hosted runner throws `subscription_binding_required` | Mikka 默认 when none | Resolve on the server; daemon never sees a missing binding | Same as C8 |
| C10 | `lib/computer/queue-run.ts:31-37,51` | Cloud task without a running machine or native binding → 409 | Queue + action card; model independent | Queue the run; resolve the model separately | Run-location fallback session (`session_01XDndLP525ADcy1Di2qbpLp`, no PR yet) |
| C11 | `lib/execution-settings.ts:104-109,313-322` | Cloud as a place requires a subscription model (`executionModelUnknown`) | Machine and model decided independently | Validate the place without the model | Run-location fallback session |
| C12 | `lib/execution-settings.ts:70-117` | Suggested default: online device first, cloud last | Own E2B first, then own device | Reorder | Run-location fallback session |
| C13 | `lib/rule-dispatch.ts:51,59`, `lib/execution-rules.ts:40,62` | Throws `agentNoDevice`, `agentHarnessMissing`, `executionModelUnknown` | Queue + 在这台 Mac 上启用 / 连接我的服务器 / 填入 E2B Key | Queue with the action card | Run-location fallback session |
| C14 | `lib/run-leases.ts:98-100`, `lib/run-retry.ts:28` | A retry waiting for an offline device fails after 30 min (`DEVICE_STAYED_OFFLINE`) | Never fail; stay queued | Keep queued with the action card | Run-location fallback session |
| C15 | `lib/cloud-computer/thread-machines.ts:64-66`, `thread-machine-limits.ts:40-46` | Cap or budget → 429 | Cap queues; budget per open question 3 | Hold the run in the queue | Run-location fallback session |
| C16 | `packages/daemon/src/harnesses.ts:17-57`, `harness-models.ts:19-36`, `lib/computer/bot-runtime.ts:22-24`, `app/v1/devices/[deviceId]/runs/[runId]/claim/route.ts:112,121` | Detects the person's own Claude Code / Codex / Cursor on PATH; sandboxes go through the same detection | Daemon-managed Agents; device capability check (OS, arch, disk, Docker); boot self-check on sandboxes | Install own copies under `~/.mikka/harness`; report capabilities instead | New daemon session (runner contract) |
| C17 | `packages/daemon/src/agents/harness-home.ts:58-66`, `packages/daemon/src/quota/local-credentials.ts:39` | Links the person's own `~/.codex/auth.json` into the run; reads local CLI credentials for quota | Never use or touch the person's own logins or config | Inject only the resolved credential into the run's temp config dir; delete at end | New daemon session (runner contract) |
| C18 | — (no device container path) | Device runs use a worktree with the person's installed CLI | Docker → disposable container from the E2B image; else worktree + temp config dir | One multi-arch Dockerfile for E2B template and device image | New daemon session (runner contract) |
| C19 | `lib/abuse/store.ts:84,92-95`, `lib/abuse/card.ts:24,60-63` | Card verification and allowance keyed by workspace | Verification per person; payment method per workspace | Key verification by user; keep the designated card per workspace | New billing follow-up (with open question 4) |
| C20 | `lib/workspace-admin/members.ts:87-92` | Removing a member moves bots only with `transferTo`; shares/card stay | Archive bots; drop shares and card designation at once | Archive + cleanup on leave | Follow-up named in #692 (§8.3) |
| C21 | `lib/secrets/e2b.ts:104-106` | E2B key per workspace | Rule 5 says the user's own key | None if open question 2 keeps it per workspace | — (pending Alex) |

## Docs

| # | Where | Says | Spec | Fix |
| --- | --- | --- | --- | --- |
| D1 | `docs/design/cloud-computer-backend.md:30-33` | The cloud computer is our infrastructure | Mikka hosts no sandboxes; Mikka Cloud runs on the workspace's E2B key | **done** (pointer + wording) |
| D2 | `docs/design/cloud-computer-backend.md:117-119` | Snapshot holds the coding CLI logins | Snapshots hold software only | **done** |
| D3 | `docs/design/cloud-computer-backend.md:155-159, 365` | Platform `E2B_API_KEY` from Infisical | Workspace key only (`hosted-abuse-controls.md`) | **done** |
| D4 | `docs/design/cloud-computer-backend.md:396-399` | A cap returns 429 | Queue | **done** (marked as code item C15) |
| D5 | `docs/execution-rules.md:29-30, 43-49, 66-73, 82-87` | Refuses an unavailable binding; device-first initial choice; discovery from the person's CLI; `switchAccount` | §2, §3, §4 | **done** (banner + per-paragraph notes; code C7, C11–C13, C16) |
| D6 | `docs/local-runtime.md:3-10, 43-45` | Runs the installed Claude Code / Codex and detects them | Daemon-managed Agents, capability check | **done** (banner; code C16–C18) |
| D7 | `docs/design/decisions/2026-10-31-1834-every-bot-replies.md` | Order without shares | §2 | **done** (`Superseded in part by`) |
| D8 | `docs/design/decisions/2026-10-31-2130-personal-vs-workspace.md:26-27, 36-37` | A credential never runs another member's bot; 「Mikka Cloud bills the workspace」 | allowOthers exception; E2B bills the workspace, Mikka charges nothing | **done** (`Superseded in part by`) |
| D9 | `docs/design/research/2026-10-31-personal-vs-workspace.md:263-267` (§6.3) | Switch off → refuse, no fallback | Mikka 默认 | Doc-only history; #692 already falls back. Left as research record |
| D10 | `docs/design/decisions.md` rows 2026-10-30 「No 自动」 (line 69) and 2026-10-29 spend guards (line 83) | Device-first initial values; `换用另一个账号`; 429 caps | §4, §5 | Frozen; superseded by the decision file |
| D11 | `docs/backend/hosted-abuse-controls.md:9-23` | Card verification per workspace, admin-only | Per person | Update with C19 when the code changes |
| D12 | `docs/factory/warp-aligned-factory.md:125-132` | Runner shapes and `workerHost` for per-thread machines | Runners per §3 | **done** (pointer) |
| D13 | `docs/design/glossary.md` | No entry for Mikka 默认 vs Mikka Cloud as model vs machine | §1 | **done** (one line) |
