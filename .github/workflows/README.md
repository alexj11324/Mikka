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

- A push to `main` triggers `ui-policy.yml` again. It is the only test
  workflow that reruns on `main`: the daemon and desktop releases wait for it
  on the exact commit (`scripts/release/ci-gate.mjs`).
- The special suites (`analytics-ssr`, `cloud-computer`, `desktop`,
  `e2b-byos`, `site-search`, `ssh-device-backend`, `unattended-sandbox`) run on
  pull requests only, and only when their paths change; each can still be run
  by hand (`workflow_dispatch`). Vercel's production build is the build check
  for `main`.
- `publish-daemon.yml` and `desktop-release.yml` run only when a path that goes
  into their package changes. Every daemon release makes installed daemons
  upgrade and restart, so a web-only change publishes neither.
- The run-dispatch and Controlled Skill improvement suites run in the CI
  database shards (`pnpm test:db`); they no longer have workflows of their own.
- The `ui-policy.yml` concurrency key includes `github.run_id` only on `main`.
  This prevents GitHub from evicting an older *pending* main verification,
  in addition to not cancelling a running main job. Superseded PR checks may
  still be cancelled.

## Cloud worker template release

`e2b-official-runtime.yml` is the only production release coordinator. It checks
the immutable worker digest, then calls `e2b-template.yml` to build unique
candidates from the official `desktop`, `claude` and `codex` bases. The builder
executes the existing additive installer beneath `/opt/mikka`, leaving an
anonymous worker preloaded at E2B's ready checkpoint. No runtime credential or
user data enters the template.

Publication has two mandatory gates: original official files retain their
SHA-256, type, mode, owner and link target; and both official Claude Code
(`claude-haiku-5-5`) and Codex (`gpt-6-luna`) execute a real subscription task on
the exact candidates. A model catalogue probe is additional capability data,
not subscription acceptance. Candidate tests use normal device enrollment,
owner-bound runs and subscription leases. Only the disposable test instances,
devices and tasks are cleaned up.
Installation preserves every original persistent entry exactly. E2B's final
boot and a disposable fresh instance are checked separately against the
recorded exact-path provider-runtime policy; original CLI/software bytes and
all other fields remain protected. File-scan verification instances are never
reused as cold-start performance samples.

After both gates pass, the workflow makes the candidates public and publishes
all three IDs, their official base kinds, worker digest, source commit and
measured models in one verified Vercel upsert inside Web deploy's production
queue. `MIKKA_CLOUD_RUNTIME_PREVIOUS` retains the previous paired configuration;
old template IDs and aliases are never updated or deleted. A failure before
publication leaves the selected release unchanged. Exact-main and exact-serving
source checks reject stale jobs. Per-variable readback detects a partial upsert;
an inconsistent tuple requires revalidation and cannot overwrite the last valid
previous configuration. A rollback uses the normal rollback PR and matched
application/worker release, preserving these gates.

PR runs use no release credentials. Main builds read the existing `E2B_API_KEY`
from Infisical `prod:/vercel`. The subscription gate reads the authorized
`ACME_DEMO_EMAIL` / `ACME_DEMO_PASSWORD` from `prod:/`, signs in normally, uses
tasks titled “测试” in `alexj11324/Mikka-handoff`, then removes its own fixtures.
Publication uses `VERCEL_TEAM_TOKEN` from `prod:/platform`. Delivery uses the
existing GitHub OIDC identity; credential values never enter reports or logs.

The worker digest excludes unrelated web lock entries and package scripts, so
unrelated changes do not rebuild templates. The existing no-new-polling rule
and task-owner E2B billing apply. See
[Alex's preservation clarification](../../docs/design/decisions/2026-11-03-1430-official-e2b-templates-unchanged.md).

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
