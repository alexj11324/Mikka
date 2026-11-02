# A personal workspace has every setting of the workspace itself

- Date: 2026-11-02
- Source: Alex, relayed by the coordinator session: a personal workspace must use shared secrets and environment variables in its tasks too, or its bots and agents get none when they run. 「个人工作区和团队工作区的区别只在『人与人之间』的东西（成员、团队、团队权限、审计日志、共享额度、离开成员的 Bot、转让）。凡是工作区自身的能力，两边都要有。」
- Rule: R-26
- Replaces, in part: [2026-11-01-2310](2026-11-01-2310-personal-and-team-workspaces-apart.md) (level 2 hid 常规 and 密钥与环境) and [2026-11-02-0203](2026-11-02-0203-personal-workspace-keeps-bots.md) (which still kept them team-only)

The two kinds of workspace differ only in what is between people. Everything
the workspace itself has, both have.

| Setting | Personal | Team | Why |
| --- | --- | --- | --- |
| 账号 group (账户 … 设备, API 与订阅, 偏好设置 with 重新播放引导) | yes | yes | The person's own, the same everywhere |
| 常规 | yes, no 转让, cannot be deleted | yes | Name, icon and address are the workspace's; transfer is between people; every account keeps its personal workspace |
| 成员 | no | yes | Between people |
| 团队 | no | yes | Between people |
| Bot 与 Agents | yes | yes | The workspace's bots and agents; 离开成员的 Bot is a team's only |
| 团队权限 | no | yes | Between people |
| 密钥与环境 | yes | yes | The workspace's secrets, injected into its own runs; in a personal workspace they are only the person's |
| 审计日志 | no | yes | Between people |
| 用量 | yes | yes | The workspace's own usage |
| 计费 | yes, without 付款 | yes | The workspace's credits and plan; 付款 (由我的卡支付, 我的点数也可用于这个团队) is between people |
| API 与订阅 › 分享给团队成员 | no | yes | Shared credits and subscriptions are between people |

The server agrees: a personal workspace is never transferred and never
deleted (`workspacePersonalDelete`).
