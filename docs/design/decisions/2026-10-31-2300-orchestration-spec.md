# Orchestration has one spec

- Date: 2026-10-31
- Source: Alex, relayed by the coordinator session: the rules of 2026-10-31
  on personal workspaces, account-bound subscriptions and shares, model
  resolution, who pays, machines (「Mikka 不托管沙盒」, own E2B → own device →
  else an immediate warning (an action card), chat never fails, no free cloud
  trial), Warp-like
  orchestration, environments that hold software only, and naming; then
  「用户设备和 E2B 一样是 runner」 (daemon-managed Agents, a disposable
  container where Docker exists, otherwise a worktree plus a temporary config
  dir, a capability check instead of Agent detection), as MVP. Asked for one
  short spec, 「不要过度设计」.
- Rule: —
- Replaces, in part:
  - [2026-10-31-1834-every-bot-replies](2026-10-31-1834-every-bot-replies.md): the order (saved choice → account subscription → Mikka 默认) gains other members' shares.
  - [2026-10-31-2130-personal-vs-workspace](2026-10-31-2130-personal-vs-workspace.md): 「a credential never runs another member's bot」 now has the opt-in exception 「分享给团队成员」; cards and verification move to the person; bots of a leaving member are paused (暂停).
  - `decisions.md` 2026-10-30 「No 自动」: the initial place is Mikka Cloud on the person's E2B key, then a device with 「允许自动调度」; 「设备离线时」 and 「Bot 额度用完时」 are replaced (answers 5 and 7 below).
  - `decisions.md` 2026-10-29 「hard spend guards」: removed (answer 3).
  - `decisions.md` 2026-10-30 「E2B runs only on the workspace's own API key」 and the 2130 decision's 「Team workspace: … the E2B key」: the E2B key is personal (answer 2).
  - The daemon's detection of the person's own Claude Code / Codex installs and logins ([local runtime](../../local-runtime.md), [execution settings](../../execution-rules.md)).

[`../orchestration.md`](../orchestration.md) is the source of truth for model
resolution, Agents (harnesses), runners and machine selection, scheduling and
leases, credentials in runs, and who pays. A document, decision or code
comment that disagrees with it gets fixed; the conflicts known on this date
are in
[2026-10-31-orchestration-conflicts](../research/2026-10-31-orchestration-conflicts.md).

## Alex's answers to the open questions

Source: Alex, 2026-10-31, relayed by the coordinator session. The Chinese
names are his; the rest is the relayed summary, not a verbatim quote.

1. **Agent per model.** API keys and custom providers are model credentials
   alongside subscriptions. GPT/OpenAI models run on Codex and every other
   model, Mikka 默认 included, on Claude Code; a person can override the Agent
   per model. Threads never queue to ask for a subscription.
2. **E2B key is personal and never shared.** A sandbox carries its owner's
   credentials and app access (for example email), so member A never runs on
   member B's E2B. In a team each member brings their own key; workspace-level
   E2B keys go away.
3. **No machine caps** when the person's own E2B key pays: the 3 / 20 running
   limits and the 60-hour budget go away.
4. **Credits.** The card-verification credit goes to the verifier's personal
   workspace. A person can share credits with a team workspace by opting in,
   as with a card designation.
5. **Quota exhausted.** With 「订阅额度用完时改用 API Key」 on (default on), the
   next run uses the owner's API key; never mid-run. When nothing is left the
   run stops and a popup lets the person choose the model or credential, then
   retry; retry does not re-resolve on its own. 「额度用完时：停下等我」 is
   removed as unclear.
6. **Environment per thread,** reused across its runs; credentials are
   injected each run and absent while paused.
7. **Device scheduling.** Each device has 「允许自动调度」, on by default for
   servers and off for personal computers (Mac / Windows). A lost E2B sandbox
   is replaced by a new one. A server that goes offline moves its run to E2B
   when the person has a key, else to a personal computer with 允许自动调度
   on, else shows an error with ways to fix it (enable scheduling on this
   computer, add an E2B key, bring the server back). This replaces
   「设备离线时」.
8. **Copy.** The page is 「API 与订阅」; the share box reads 「分享给团队成员」;
   a leaving member's bots are paused (暂停).
