# Push is what the GitHub App grants; Mikka asks for nothing on top

- Date: 2026-11-01
- Source: Alex, relayed by the coordinator session after the ZHIX-3 dispatch
  asked for a push card on a read-only investigation (「这里为什么还需要
  push？」). The relayed decision: 「用户已经在 GitHub App 里授予的权限，Mikka
  不能再找用户要授权」; push is allowed when the repository's GitHub App
  installation grants contents:write; only when the App lacks it is the person
  sent to GitHub to install or widen it; settings that duplicate the App
  permission are removed or shown read-only as 「由 GitHub App 授权决定」.
- Rule: —
- Replaces: [2026-11-01-0500-push-needs-repository-approval](2026-11-01-0500-push-needs-repository-approval.md),
  and the 2026-10-28 rows on per-repository push approval in `../decisions.md`

A run that may commit is admitted to push when GitHub says so: the Mikka
GitHub App's installation on the repository grants contents: write, and the
person's own linked GitHub account may write to it. Dispatch checks this live
and records it; the run's GitHub token and the pull request check GitHub live
again. There is no push-approval card and no Coordinator tool that asks for
one.

What follows:

- When the App is missing, suspended or lacks contents: write, dispatch is
  refused with that reason and the GitHub installation link; the Coordinator
  sends the person to GitHub and can offer the task as a read-only run.
- The person's own write access stays required. The App is shared by every
  Mikka user, so without it one person's dispatch could push to another
  person's repository.
- A workspace policy or read-only mode that denies `git_push` still denies.
  `ask` no longer asks.
- Plugins › GitHub shows 推送分支 as 「由 GitHub App 授权决定」, with no
  switch. 创建 Pull Request keeps its allow / ask / deny: it is a separate step
  the App permission does not decide.
- Only github.com repositories can be pushed.
- A read-only run (an investigation) never needs any of this.
