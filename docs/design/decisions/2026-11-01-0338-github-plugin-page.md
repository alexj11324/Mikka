# GitHub's plugin page shows what the plugin does, its tools and its repositories

- Date: 2026-11-01
- Source: Alex, MVP bug triage relayed by the coordinator: 「插件这一块仍然没有，一些信息、读写工具之类全部都没有」 and 「按照道理来说应该直接跳转到 GitHub 才对啊，怎么还在中间跳到我们的网页端来了呀？」
- Rule: R-40
- Replaces: the GitHub part of `2026-10-31-1952-app-page-details.md` («GitHub, Linear and Telegram keep their own pages»)

Plugins › GitHub follows a store app's page order:

1. Header: icon, name and 关联 GitHub until a connection exists.
2. One paragraph on what Agents do through the plugin.
3. 已连接的账户: @login with 已授权 N 个仓库, and 断开连接 in its menu
   (with a confirmation).
4. 工具, grouped 写入 / 读取 with the same component as store apps. The list
   is what the code does, not GitHub's API: write is 推送分支 and
   创建 Pull Request (the run token's contents and pull_requests write);
   read is 读取代码, 读取 Pull Request, 读取 Issue and 读取 CI 检查.
   A new ability is added to the list with its code.
5. 仓库: the repositories the Mikka GitHub App reaches for this person, with
   管理授权 (or 授权仓库) opening the App's installation page on GitHub.

关联 GitHub goes straight to GitHub's authorization. In the desktop app it
opens the GitHub start itself in the system browser (not a Mikka settings
page); a browser that is not signed in signs in first and comes back to the
GitHub page.
