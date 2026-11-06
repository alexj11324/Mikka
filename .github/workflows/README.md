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

Current replacement: `e2b-official-runtime.yml` validates new official instances
without building or changing a template. It compares file/link/permission
manifests, bootstraps the pinned Mikka source beneath `/opt/mikka`, and measures
the actual CLI model catalogue. Only reviewed `main` runs receive the existing
E2B validation key and Vercel release token in separate jobs. Publication pairs
the official template names, worker digest, source commit and model catalogue in
one request, and redeploys only a READY application of that exact Git commit.
The worker digest ignores package.json scripts and lockfile entries outside
the daemon install. When that digest and the published variables already match
production, the workflow does not rebuild or redeploy.
If the latest READY application has moved to another source, publication stops
before changing configuration; retry against the latest reviewed main rather
than replacing a newer application with the older release.
PR runs have no secrets and run source/publisher checks. This validation does
not send a model prompt and does not replace real subscription acceptance.

The historical workflow below is retained unchanged and **disabled** after
[the preservation decision](../../docs/design/decisions/2026-11-03-1430-official-e2b-templates-unchanged.md).
Do not resume it as part of the replacement release.

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

## Official UI overlay

`web-deploy.yml` and `desktop-release.yml` alone read the private UI through
Infisical OIDC and `HOSTED_UI_READ_TOKEN` (`prod:/platform`, Contents: read on
`alexj11324/mikka-hosted-ui` only). They set `MIKKA_UI_OVERLAY_DIR` and record
`MIKKA_UI_OVERLAY_SHA`; public and fork PRs still build the default public UI
without either variable or any private secret. The production Web job checks
public main plus private main on each main update. Private main pushes dispatch
the official Web job again with `overlay-refresh: true`, so docs-only changes
cannot skip an overlay rebuild; they also dispatch desktop with the expected
overlay SHA. No schedule is involved.

Web verifies `/mikka/api/version`'s `build` and `overlaySha`. Desktop uses the
existing matching-Web source gate and checks out **that Web overlay SHA**, then
verifies equality again before publishing. New desktop runs cancel older runs.
Desktop seals, verifies and publishes from one macOS job with no public Actions
artifact upload. Release assets include the sealed `mikka-ui-overlay.json`.
Official compiler logs stay on the ephemeral runner, and both distributable
static output and the signed ASAR's app-owned dist are audited for source maps.
See [the deployment runbook](../../docs/operations/web-deploy.md#official-private-ui-overlay)
for identities, rollout, source exposure boundaries and recovery.
