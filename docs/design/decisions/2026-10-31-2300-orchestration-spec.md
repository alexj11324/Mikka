# Orchestration has one spec

- Date: 2026-10-31
- Source: Alex, relayed by the coordinator session: the rules of 2026-10-31
  on personal workspaces, account-bound subscriptions and shares, model
  resolution, who pays, machines (「Mikka 不托管沙盒」, own E2B → own device →
  queue with an action card, never fail, no free cloud trial), Warp-like
  orchestration, environments that hold software only, and naming; then
  「用户设备和 E2B 一样是 runner」 (daemon-managed Agents, a disposable
  container where Docker exists, otherwise a worktree plus a temporary config
  dir, a capability check instead of Agent detection), as MVP. Asked for one
  short spec, 「不要过度设计」.
- Rule: —
- Replaces, in part:
  - [2026-10-31-1834-every-bot-replies](2026-10-31-1834-every-bot-replies.md): the order (saved choice → account subscription → Mikka 默认) gains other members' shares.
  - [2026-10-31-2130-personal-vs-workspace](2026-10-31-2130-personal-vs-workspace.md): 「a credential never runs another member's bot」 now has the opt-in exception 「团队成员也可以用」; cards and verification move to the person.
  - `decisions.md` 2026-10-30 「No 自动」: the initial place is Mikka Cloud when the workspace has an E2B key, then a device; 「Bot 额度用完时 · 换用另一个账号」 no longer switches inside a run.
  - `decisions.md` 2026-10-29 「hard spend guards」: hitting a cap queues the run instead of refusing it.
  - The daemon's detection of the person's own Claude Code / Codex installs and logins ([local runtime](../../local-runtime.md), [execution settings](../../execution-rules.md)).

[`../orchestration.md`](../orchestration.md) is the source of truth for model
resolution, Agents (harnesses), runners and machine selection, scheduling and
leases, credentials in runs, and who pays. A document, decision or code
comment that disagrees with it gets fixed; the conflicts known on this date
are in
[2026-10-31-orchestration-conflicts](../research/2026-10-31-orchestration-conflicts.md).

## Open questions for Alex

Each has a recommended answer; the spec follows the recommendation until Alex
says otherwise.

1. **Which Agent runs a thread on Mikka 默认?** Today only bot chats use the
   hosted model; threads need a Claude or Codex login.
   Recommended: Codex for now, pointed at Mikka's model endpoint with a
   run-scoped token billed to the workspace, so no provider key enters the
   environment. Until that exists, a thread with no subscription stays queued
   with 连接订阅 rather than failing.
2. **Whose E2B key?** Rule 5 says 「the user's own E2B key」; today the key
   belongs to the workspace (decision 2026-10-30, 2130).
   Recommended: keep it per workspace. In a personal workspace it is the
   person's own key; a team sets a team key. No member key inside a team for
   MVP.
3. **Machine caps now that the person's E2B pays.** Today: 3 running per owner,
   20 per workspace, 60 compute hours per owner per 30 days, refused with 429.
   Recommended: keep 3 per owner and 20 per workspace as queue limits (they
   guard E2B's own concurrency ceiling), drop the 60-hour budget (Mikka no
   longer pays), never refuse.
4. **The USD 1 allowance under per-person verification.** Today it goes once
   per card to the first workspace that verifies it.
   Recommended: once per card, to the verifying person's personal workspace.
5. **Bot 额度用完时.** With no mid-run switch, 停下等我 / 换用另一个账号 only
   differ at the next run.
   Recommended: retire the setting. A run whose subscription runs out stops
   with 订阅额度已用完 and 重试; the next run resolves again by the normal
   order.
6. **Environment per run or per thread on Mikka Cloud?** Devices start every
   run clean; today an E2B thread sandbox pauses between runs of a thread.
   Recommended: keep pausing on E2B (faster follow-ups, no credential inside
   while paused) and treat the thread's branch as the only state that must
   survive, so either runner can pick up the next run.
7. **设备离线时 default.** Today `wait`.
   Recommended: keep `wait` for runs pinned to a device; unpinned runs already
   follow the fallback order.
