# What the GitHub App grants is never asked: no 询问 for push or pull requests

- Date: 2026-11-01
- Source: Alex, relayed by the coordinator session. He questioned why the
  permission settings offer 询问 at all. The rule: an ability the App already
  granted is not asked of the person again; any remaining judgment belongs to
  the Decision API, not a coded rule.
- Rule: —
- Replaces: the 创建 Pull Request line of
  [2026-11-01-1215-push-by-github-app](2026-11-01-1215-push-by-github-app.md)

- 创建 Pull Request offers only 允许 and 拒绝, default 允许. A stored 询问 is
  migrated to 允许. There is no pull request card.
- `git_push` offers only allow and deny; the GitHub App grant decides it
  (decision 2026-11-01-1215). A stored setting can only deny: unset, or an ask
  migrated to allow, leaves the decision to the App. A run is never sent ask:
  an admitted run gets allow, every other run deny, and a run policy that does
  not say allow never pushes.
- Plugins › GitHub shows 推送分支 as 「由 GitHub App 授权决定」.
