# The issue's owner merges its PR and accepts it in production

- Date: 2026-11-03
- Source: Alex, 2026-11-03, on how work is assigned and shipped: work goes
  through a GitHub issue to one agent, which owns it end to end and never
  pushes directly to main.
- Rule: — (process, not product)
- Superseded in part by: [2026-11-07-1400](2026-11-07-1400-production-acceptance-scope.md) (rule 5 requires production acceptance only for external services that a local production build cannot exercise; every owner still watches deployment).
- Superseded in part by: [2026-11-05-1632](2026-11-05-1632-no-vercel-preview.md) (no Vercel Preview; verify before merge in CI or a local/Docker production build with an isolated database)
- Replaces:
  - [2026-11-01-2225-api-cli-acceptance-and-backend-owner](2026-11-01-2225-api-cli-acceptance-and-backend-owner.md)
    item 3, "Backend owner. Backend changes (server, API, database, daemon)
    are Codex's … anyone else asks before changing the backend";
  - [2026-11-01-1545-trunk-based](2026-11-01-1545-trunk-based.md) rule 2,
    "When CI is green, the coordinator squash-merges it directly";
  - 2026-11-03-0310 "Fixes push straight to main", rules 1–3: "A fix opens no
    PR … pushed there, without force", "The coordinator reviews it on `main`
    after the push", and the credentials/auth summary sent after the push.

1. **One issue, one owner.** Work is assigned through a GitHub issue to one
   agent. That agent owns it end to end. No area, backend included, belongs
   to a fixed agent.
2. **Always a PR.** The owner opens a PR for the change. Nobody pushes
   directly to `main`, fixes included.
3. **The owner merges.** Once CI is green, the owner squash-merges its own
   PR. The coordinator does not merge it.
4. **The owner watches the deploy.** After the merge, the owner watches the
   production deploy until it finishes.
5. **Real production acceptance.** The owner then accepts the change in
   production for real, not only by tests or a preview.
6. **Evidence on the issue.** The owner writes the evidence to the issue and
   closes it.

Still in force: verify end to end locally, or on a preview with its own
database branch, before merging; production is never the test environment
for unverified changes (rule 4 of 2026-11-03-0310). Changes to auth, signup,
privilege or credentials, and UI screenshots, are still reviewed before
merge (1545 rule 3).

What it replaces: before this, fixes were pushed straight to `main` and
reviewed there afterwards by the coordinator (0310), other PRs were
squash-merged by the coordinator (1545), and backend changes were Codex's
(2225). Alex moved the whole change, through deploy and production
acceptance, to the one agent that holds the issue.
