# No workspace name in breadcrumbs

- Date: 2026-11-01
- Source: Alex, on the task page's breadcrumb 「Zhixuan Jiang的工作区 > Board > ZHIX-2 …」, relayed by the coordinating session: 「你前面不应该加"工作区"，那点都点不动。工作区只有这一个。切换工作区必须在左下角头像那里去切换。你这里写这个东西没有任何意义。」
- Rule: R-79
- Replaces: —

Breadcrumbs, title bars and page headers do not show the workspace's name. It
cannot be clicked there, only one workspace is on screen, and the avatar menu
at the bottom left is the one place that shows and switches the workspace.

- The task page's breadcrumb starts at 看板 (`components/workspace/issue-detail-header.tsx`); its narrow-width menu no longer lists the workspace either.
- The phone title bar (`components/app-shell.tsx`) shows only the page's title on workspace pages. A team page keeps the team as its first crumb, and settings keeps 设置: those name something other than the workspace.
- 设置's sidebar heads its workspace group with the workspace's name. That is a group heading saying which workspace those settings apply to, not a crumb, so it stays.
