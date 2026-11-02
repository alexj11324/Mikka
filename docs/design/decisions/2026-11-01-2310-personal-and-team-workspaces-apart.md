# Personal and team workspaces are kept apart

- Date: 2026-11-01
- Source: Alex, relayed by the coordinator session: 「个人工作区归个人工作区，团队工作区归团队工作区，两者互不相干。个人工作区不显示工作区设置……个人工作区不再处理工作相关事件，只处理个人的事件。团队工作区单独分开，专门处理团队相关的工作事项。」 and 「个人还是需要计费的吧。订阅页还是需要的，给个人用的订阅你还加上啊，就是 API 之类的，只不过不分享给团队而已」
- Rule: R-26
- Superseded in part by: [2026-11-02-0203](2026-11-02-0203-personal-workspace-keeps-bots.md) (Bot 与 Agents shows in a personal workspace too), [2026-11-02-0216](2026-11-02-0216-personal-workspace-has-workspace-settings.md) and [2026-11-02-0230](2026-11-02-0230-workspace-is-the-tenant.md) (密钥与环境 and the other workspace settings show in both kinds; only what is between people is team-only)
- Replaces, in part, [2026-10-31-2130-personal-vs-workspace](2026-10-31-2130-personal-vs-workspace.md) (#687, 「一个人也是一个工作区」):
  - level 1: the account level now also holds profile memory (个人资料类记忆), security, 登录与密钥 and 「API 与订阅」 with the E2B key (see 1 below);
  - level 2: a personal workspace hides every team setting, not only 成员, 团队权限 and 审计日志, and keeps personal 计费 and 用量;
  - level 3: the E2B key is not the team's (already [2300](2026-10-31-2300-orchestration-spec.md)); the team level is listed in 3 below;
  - "Memory is kept per workspace": profile memory, the facts about the person, is the account's; every other memory stays in its workspace (1 and the memory paragraph below);
  - a personal workspace no longer handles work events; work belongs to a team workspace.
- Also replaces: R-26's "a workspace task can be turned back into a personal one" and the `decisions.md` row 2026-10-24 21:57 「Task scope is two-way」.

Three levels, kept apart:

1. **Account**, the same in every workspace: 账户, security, 偏好, 通知,
   个人资料类记忆 (profile memory), 登录与密钥, 设备, and 「API 与订阅」 (subscriptions, API keys, the
   E2B key). A person can always use their own credentials
   ([2240](2026-11-01-2240-own-credentials-always-usable.md)).
2. **Personal workspace**: only the person's own bots, chats, tasks and
   threads, and only personal events. Its settings keep personal 计费 and
   用量 (personal credits, personal invoices). They show no team settings:
   no 成员, 团队, 团队权限 or 审计日志 (~~or 密钥与环境~~, superseded by
   [0230](2026-11-02-0230-workspace-is-the-tenant.md)). In 「API 与订阅」 there is
   no 「这个工作区 › 分享给团队成员」 section and no 「我的点数也可用于这个团队」.
3. **Team workspace**: 成员, 团队, 团队权限, ~~Bot 与 Agents, 密钥与环境,~~
   审计日志 (Bot 与 Agents and 密钥与环境 are in both kinds: 0203, 0230), team 用量 and team 计费. 「分享我的订阅给团队成员」 and
   「我的点数用于这个团队」 appear only in a team workspace's settings.

**Memory.** Facts about the person (profile facts: preferences, how to address
them and the like) follow the account and are visible in every workspace.
A bot's memory, team knowledge and memory drawn from team chats stay in the
workspace they belong to; personal and team memory never cross.

Nothing crosses between them: personal tasks and chats never enter a team,
and a team's never enter the personal workspace. A personal workspace cannot
be "upgraded" into a team; the person creates a new team workspace.
