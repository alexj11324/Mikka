# Account menu icons, a visible settings search, no dark composer stroke

- Date: 2026-10-31
- Source: Alex, on 2026-10-31 screenshots: 「pop over 出来，它仍然是没有图标的呀，就不太对吧」 (account menu); 「你这样看你觉得好看吗？这都看不见了」 (设置 search field); 「没有输入字的时候是没有线的，应该是阴影吧。但是我输入字以后，突然之间会加上一条黑色的描线」 (composer)
- Rule: R-75, R-31
- Replaces: account menu rows without icons; `SidebarInput` with `bg-background`; the composer's `focus-visible:border-ring`

1. Every action row in the avatar menu leads with a muted lucide icon in the
   20px box the workspace avatars use, so all rows share one text column:
   创建工作区 `Plus`, 设置 `Settings`, 添加账户 `UserPlus`, 退出登录 `LogOut`.
2. The 设置 column's 「搜索设置…」 field is the shared `SearchInput`
   (`--control` fill, no outline). It was a `SidebarInput` painted
   `bg-background`, which inside 设置 is the column's own colour, so it
   vanished. `SidebarInput` now fills with `--control` too.
3. The chat composer looks the same empty, focused and typing: the 1px
   `--rule` line and the soft shadow. Focus only deepens the shadow, as Codex,
   and never switches the line to `--ring`.
