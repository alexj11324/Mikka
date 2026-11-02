# The workspace 电脑 policy gates computer tasks only

- Date: 2026-11-02
- Source: the coordinating Claude session's decision, relayed in the E2B
  templates session on 2026-11-02: 「工作区电脑策略只限制电脑/桌面任务，代码任务不受它约束（领取和排队两处都一样）」. Based on
  [2026-11-02-0231 workspace is the tenant](2026-11-02-0231-workspace-is-the-tenant.md)
  (on branch `claude/information-architecture`, not yet on main) and
  [2026-11-02-0251](2026-11-02-0251-desktop-runs-get-their-own-machine.md).
- Rule: —
- Replaces: —

A workspace's 电脑 policy (`workspace_computer_policies.permission`, allow or
deny) decides whether the workspace's runs may use a computer: a desktop, its
browser and what is logged in there. It does not decide whether a workspace
may run code.

- A **computer task** is a run whose repository has no remote, so it needs a
  desktop. Under deny it is refused when it is queued
  (`lib/computer/queue-run.ts`, `queueCloudRun`) and when it is claimed
  (`lib/computer/claim.ts`, `claimCloudRun`).
- A **repository task** is a run whose repository has a remote. It runs on a
  task machine without a desktop (decision 2026-11-01-2335). Under either policy
  it is queued (`queueCloudRun`, and `cloudReady` in `lib/rule-dispatch.ts`) and
  claimed, and its claim never carries a computer grant (permission `deny`,
  #918).

Gates on actual computer use stay on the policy: opening a thread desktop, the
cloud computer's driver and browser, and the credential broker.
