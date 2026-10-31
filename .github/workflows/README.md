# CI workflow strategy

Mikka follows the premerge/postmerge split used by OpenAI Codex, while retaining
its existing protected status names and real acceptance coverage.

## Pull requests: blocking checks

- `ui-policy.yml` runs for `pull_request` and `merge_group`, not for each
  same-repository branch push. Actions' default PR checkout runs GitHub's
  synthetic merge commit, including the PR together with its target branch at
  the time of the check. A changed PR head gets a new check run.
- Keep `UI policy (strict)` and `Production build and browser interactions`
  successful for non-documentation PRs; the latter runs isolated PostgreSQL
  and DB/migration integration checks. The PR's production build is performed
  in `browser-tests.yml`, not redundantly in `ui-policy.yml`.
- `browser-tests.yml` runs `Browser tests (before merge)`: smoke plus
  changed-area specs, a real isolated PostgreSQL database and the applicable
  Factory/daemon/browser acceptance. `integrate/*` PRs use the full tier.
- `GitGuardian Security Checks` is a separate external required check.
- All four existing required names remain intact. Do not silently replace
  them with a new aggregate check until the GitHub branch-protection settings
  have been migrated and verified.

## Main pushes: postmerge checks

- A push to `main` triggers `ui-policy.yml` again and the functional
  `browser-tests.yml` tier (two shards). Nightly and manual browser runs
  retain full coverage; expensive desktop/release workflows stay independent.
- Both workflow concurrency keys include `github.run_id` only on `main`.
  This prevents GitHub from evicting an older *pending* main verification,
  in addition to not cancelling a running main job. Superseded PR checks may
  still be cancelled.
- The existing red-main browser issue workflow tracks regressions after merge.

## GitHub branch protection (separate repository setting)

Keep required status checks enabled. Disable **Require branches to be up to
date before merging** (GitHub's *loose* status-check mode), as in Codex.
Moving `main` does not by itself force every otherwise-mergeable PR to rebase
or rerun its existing checks. Git merge conflicts and PR-head changes still
need resolution and a fresh check; integration risks can require additional
targeted tests.

This branch-protection toggle **cannot be changed by editing workflow YAML**.
Verify it in `Settings > Branches > main > Edit`, and do not claim that the
repository is already in loose mode without verifying its effective settings.

Do not skip the required gates, silently accept failed/skipped dependencies or
publish from a red PR. The workflows run the trusted docs/CI classifier from
`origin/main`; documentation-only PRs still publish their required gate names.
CI source changes are not classified as documentation-only.
