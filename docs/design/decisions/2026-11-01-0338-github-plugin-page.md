# GitHub's plugin page: connection, repository access and abilities with their own allow / ask / deny

- Date: 2026-11-01
- Source: Alex, MVP bug triage relayed by the coordinator: 「插件这一块仍然没有，一些信息、读写工具之类全部都没有」 and 「按照道理来说应该直接跳转到 GitHub 才对啊，怎么还在中间跳到我们的网页端来了呀？」; layout and permission wiring approved by Alex's coordinator the same day
- Rule: R-40, R-74, R-77
- Replaces: the GitHub part of `2026-10-31-1952-app-page-details.md` («GitHub, Linear and Telegram keep their own pages»)

Accepted Figma frames (file `zPe5LKycb2XuT1ivCLRw07`, page `773:2`): `773:3`
connected, `775:4` not connected, `775:131` link failed, `775:240` repository
dialog, and their dark twins below them.

Plugins › GitHub follows a store app's page, top to bottom:

1. Breadcrumb, then the header: icon, 「GitHub」 and, until a connection
   exists, 「关联 GitHub」 on the right. It goes straight to GitHub's
   authorization (in the desktop app through the system browser).
2. One destructive alert under the header when something failed:
   「无法关联 GitHub」, a failed read, or an expired link.
3. One paragraph on what Agents do through the plugin.
4. Connected only — 连接: the GitHub tile and `@login`, with 「断开」 behind a
   confirmation.
5. Connected only — 仓库访问: one row, 「已授权 N 个仓库」. The row opens
   「已授权的仓库」, a dialog with search and the list (each name opens on
   GitHub, 私有 marks private ones). Repository names never appear on the
   card itself. 「在 GitHub 上管理 ↗」 (or 授权仓库 before an installation)
   opens the App's installation page.
6. 能力, connected or not: 写入 2 — 推送分支 and 创建 Pull Request, each with
   the segmented 允许 / 询问 / 拒绝 — and 读取 4 — 读取代码, 读取 Pull Request,
   读取 Issue, 读取 CI 检查, with no control (reads run directly, R-77). The
   list is what the code does; a new ability is added with its code.

The two writes are the person's own Coordinator settings, with no second
store:

- 推送分支 is the Coordinator's `git_push` (`agent_kit_heads.cli_run_policy`):
  the daemon asks with an approval card on 询问, run admission and the
  run-token issuer refuse on 拒绝. Unset stays 询问.
- 创建 Pull Request is `github_pull_request` in the Coordinator's
  `external_write_permissions`. 拒绝 blocks the pull request (the pushed
  branch stays); 询问 shows a 创建 Pull Request card in chat and opens it once
  approved; unset or 允许 opens it once the push was approved, as before. It
  only narrows the per-repository push approval, never replaces it.
