# Pushing needs the repository approval and git_push together

- Date: 2026-11-01
- Source: the coordinator session, relaying the decision taken from industry
  practice: pushing needs two independent gates, both true (AND). The
  per-repository push approval decides which repositories may be pushed; the
  `git_push` action permission (allow / ask / deny) decides whether a human
  approval card is shown before a push. "`git_push: allow` must mean 'no
  approval card', never 'skip the repository authorization'."
- Rule: —
- Replaces: — (narrows the 2026-10-28 rows on per-repository push approval in
  `../decisions.md`; those rows stand)

A task is admitted to push, its run gets a GitHub push token, and its result
is published only when the owner has a valid push approval for that
repository (`repository_settings.push`, recorded by the person's own
decision). `git_push: allow` removes the confirmation at push time and nothing
else; `ask` keeps it; `deny` on either gate denies.

What follows:

- `git_push: allow` without a repository approval admits nothing and issues
  no token. A claim without a publication sends a configured `allow` as `ask`.
- New admission receipts always carry `authority: 'repository_approval'` and
  the approval's `approvedAt`. Old receipts with
  `authority: 'configured_allow'` and no `approvedAt` still parse, so old rows
  stay readable, but they are not admitted: retries, replays, claims, run
  messages, tokens and publication refuse them.
- No automatic or migrated approval is written. Factory dispatches its
  authorized repositories under the same rule: the owner's recorded approval
  must exist.
