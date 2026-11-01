# Personal vs workspace ownership

- Date: 2026-10-31
- Source: Alex, relayed by the coordinator: 「一个人也是一个工作区」,
  「不管你在哪个工作区，你都可以用自己账号」, and on the proposal
  「可以按你的建议来」. Research and audit:
  [personal vs workspace](../research/2026-10-31-personal-vs-workspace.md)
- Rule: —
- Superseded in part by: [2026-11-01-2240-own-credentials-always-usable](2026-11-01-2240-own-credentials-always-usable.md) (an admin can no longer switch off personal subscriptions or API keys)
- Superseded by: [bindings belong to the person](2026-10-31-2225-bindings-belong-to-the-person.md), for the admin switches, where subscriptions run and who pays for work with no workspace of its own
- Superseded in part by: [2026-10-31-2300-orchestration-spec](2026-10-31-2300-orchestration-spec.md) (a member may share a credential with 「分享给团队成员」; cards and verification belong to the person; the E2B key is personal, never a team's, and E2B bills it, not Mikka; a leaving member's bots are paused; 「设备离线时」 and 「Bot 额度用完时」 are replaced)
- Replaces: subscriptions stored and resolved per (owner, workspace); the
  Coordinator and memory extraction billed to the oldest workspace

Mikka has three levels, as in ChatGPT and Claude:

1. **Account**: identity, sign-in, preferences, notifications, app
   connections, saved logins, devices and model subscriptions. These follow
   the person into every workspace they belong to.
2. **Personal workspace**: one per person, with exactly one member. Every
   user gets one, including users who signed up through an invite, and it
   is marked by `kind`. Settings hide 成员, 团队权限 and 审计日志 there.
3. **Team workspace**: members, policies, secrets, the E2B key, points and
   billing.

A bot lives in one workspace and has one owner. The Coordinator is one per
person per workspace.

A credential runs only its owner's bots, in any workspace the owner belongs
to, and never another member's bot. A team admin can switch off personal
subscriptions, personal app connections or personal devices for that
workspace, all on by default, but never sees or uses them.

Memory is kept per workspace, so personal memory never reaches a team.
Existing memory moves to the person's personal workspace.

Who pays:
- Subscription runs use the owner's own plan quota.
- Mikka 默认, Mikka Cloud, the Coordinator and memory extraction bill the
  workspace they run in.
- Work with no workspace of its own bills the personal workspace, never
  「the oldest workspace」.

When a member leaves a team, their bots there are archived (paused). An
admin can take a bot over, and it then runs on the admin's or the
workspace's resources. The member's credentials never stay behind.

设备离线时 and Bot 额度用完时 are account settings and move to
个人 › 模型与额度.
