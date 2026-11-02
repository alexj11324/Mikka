# CI workflow strategy

Mikka follows the premerge/postmerge split used by OpenAI Codex, while retaining
its existing protected status names and real acceptance coverage.

## Pull requests: blocking checks

- `ui-policy.yml` runs for `pull_request` and `merge_group`, not for each
  same-repository branch push. Actions' default PR checkout runs GitHub's
  synthetic merge commit, including the PR together with its target branch at
  the time of the check. A changed PR head gets a new check run.
- Keep `UI policy (strict)` and `Production build and browser interactions`
  successful for non-documentation PRs; the latter is the gate over the four
  isolated PostgreSQL DB/migration integration shards. Despite its name, CI
  runs no production build (decision 2026-11-01-0230); Vercel builds `main`.
- CI runs no browser tests, not even by hand (decision 2026-11-01-1520).
  `browser-gate.yml` only keeps the protected check name
  `Browser tests (before merge)` and passes at once; delete it once that name
  is removed from the required checks in the repository settings.
- `GitGuardian Security Checks` is a separate external required check.
- All four existing required names remain intact. Do not silently replace
  them with a new aggregate check until the GitHub branch-protection settings
  have been migrated and verified.

## Main pushes: postmerge checks

- A push to `main` triggers `ui-policy.yml` again. No browser run follows a
  main push or runs nightly; expensive desktop/release workflows stay
  independent.
- Both workflow concurrency keys include `github.run_id` only on `main`.
  This prevents GitHub from evicting an older *pending* main verification,
  in addition to not cancelling a running main job. Superseded PR checks may
  still be cancelled.

## Cloud worker template release

Cloud machines start from E2B's own `desktop`, `claude` and `codex` templates
with the Mikka worker added ([decision 2026-11-01-2335](../../docs/design/decisions/2026-11-01-2335-e2b-official-templates.md)).

- `e2b-template.yml` builds the three templates from `main`, makes them
  public and points Vercel Production at them (all three template ids and the
  worker hash in one request), then redeploys Production. A `check` job first compares the worker
  hash with Production's and stops when it is unchanged. Pull requests run only
  its unit tests. Branch testing uses `-dev` templates built from the branch,
  never the production templates or Vercel's production variables
  (`docs/dev-workflow.md` § 7).
  The build job holds only `E2B_API_KEY` (Infisical `prod:/vercel`) and the
  check and publish jobs only `VERCEL_TEAM_TOKEN` (`prod:/platform`), both read through the
  existing GitHub OIDC identity.

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
