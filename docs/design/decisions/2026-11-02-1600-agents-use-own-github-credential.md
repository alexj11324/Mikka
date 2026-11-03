# Agents use the person's own GitHub credential; Mikka adds no push gate

- Date: 2026-11-02
- Source: Alex, relayed by the coordinator session: 「Codex 和 Claude Code
  都不是这样做的……你防不住的，只能靠模型自己的判断。你设得太紧了，把凭据给它。」
  ("Codex and Claude Code don't do it this way… you can't prevent it, only the
  model's own judgment. You set it too tight, give it the credential.")
- Rule: R-77 (every GitHub ability is listed with no control)
- Replaces: [2026-11-01-1215-push-by-github-app](2026-11-01-1215-push-by-github-app.md),
  [2026-11-01-0500-push-needs-repository-approval](2026-11-01-0500-push-needs-repository-approval.md),
  the GitHub part of [2026-11-01-1310-no-ask-for-app-granted-abilities](2026-11-01-1310-no-ask-for-app-granted-abilities.md),
  and the 能力 section of [2026-11-01-0338-github-plugin-page](2026-11-01-0338-github-plugin-page.md)
- Superseded by: [2026-11-02-1730-coordinator-github-mcp](2026-11-02-1730-coordinator-github-mcp.md),
  for how the Coordinator does GitHub operations directly only

An agent run (Claude Code, Codex or Cursor on the person's computer, and cloud
runs) gets the person's own GitHub credential, the same as `gh auth login` in
their own terminal: the GitHub App user token of their Plugins › GitHub
connection (or their GitHub sign-in account linked before connections
existed). It reaches every repository the person authorized, that is every
repository the Mikka GitHub App is installed on, and can clone, commit, push,
open pull requests and comment. What the agent does with it is the model's own
judgment.

What follows:

- There is no first-push approval per repository, no push grant, and no
  difference in credentials between a read-only run and one that pushes.
  readOnly stays as task intent only: the worktree is not writable.
- `git_push` in a stored policy and 创建 Pull Request in Plugins › GitHub no
  longer gate anything. The stored values stay readable; nothing is migrated.
- The run gets the credential through its run-local git credential helper and
  gh wrapper, fetched with its run token for as long as the run holds its
  lease. It is never in chat, in argv or in an environment dump.
- A task run still delivers as before: it pushes its task branch and opens the
  pull request; Mikka reads the result back. When Mikka opens or adopts the
  pull request itself, it uses the run owner's own token too.
- The Coordinator can do GitHub operations directly with the person's
  credential (read issues, pull requests and CI; comment; open pull requests),
  as a supplement to dispatching.
- Plugins › GitHub lists every ability (推送分支, 创建 Pull Request and the
  reads) with no control.

The safety floor, and the only limits: a credential never appears in chat,
logs, error messages or memory; and a run, or the Coordinator, only ever gets
its own person's credential, never someone else's. Nothing else is added.

Earlier rule, from 2026-11-01-0500 (now removed): a push needed both the repository approval and `git_push`; 1215 then let the GitHub App grant decide. Alex dropped both gates because a gate cannot stop a model that holds the credential.
