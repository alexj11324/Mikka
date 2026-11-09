# CI workflow strategy

This guide maps required pull-request checks, release jobs and their source
bindings. Current workflow files define the triggers and selected coverage.

## Pull requests: blocking checks

- `ui-policy.yml` runs for `pull_request` and `merge_group`, not for each
  same-repository branch push. Actions' default PR checkout runs GitHub's
  synthetic merge commit, including the PR together with its target branch at
  the time of the check. A changed PR head gets a new check run.
- Keep `UI policy (strict)` and `Production build and browser interactions`
  successful for non-documentation PRs; the latter gates the selected isolated PostgreSQL suites across 1–4 dynamic
  shards. Full inventory validation runs even when DB execution is skipped. Despite its name, CI
  does not build the production Web release artifact. `web-deploy.yml` builds
  `main` on GitHub Actions and uploads the prebuilt output to Vercel.
- Ordinary acceptance uses API/CLI flows under decision 2026-11-01-1520.
  Targeted Desktop, Analytics and self-hosted jobs retain their selected browser
  checks. `browser-gate.yml` only keeps the protected check name
  `Browser tests (before merge)` and passes at once; delete it once that name
  is removed from the required checks in the repository settings.
- `GitGuardian Security Checks` is a separate external required check.
- All four existing required names remain intact. Do not silently replace
  them with a new aggregate check until the GitHub branch-protection settings
  have been migrated and verified.

## Main pushes: postmerge checks

- A push to `main` triggers the required `ui-policy.yml` checks again. Daemon
  and desktop releases wait for that exact commit
  (`scripts/release/ci-gate.mjs`). Production acceptance workflows have their
  own successful-Web triggers and account queues.
- The special suites (`analytics-ssr`, `cloud-computer`, `desktop`,
  `e2b-byos`, `site-search`, `ssh-device-backend`, `unattended-sandbox`) run on
  pull requests only, selected by trusted dependencies or their existing path filters; each can still be run
  by hand (`workflow_dispatch`). The Web release workflow builds and deploys
  `main` through Vercel.
- `publish-daemon.yml` uses daemon/package-input path filters.
  `desktop-release.yml` also watches the shared frontend, UI and API inputs, so
  a Web UI change can trigger a desktop release. A Markdown file under a
  watched directory still matches those release filters. Read the exact
  workflow paths before predicting release work.
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
owner-bound runs and subscription leases. Each release records original CLI
paths and hashes in its own manifest; production, probing and acceptance use
the same resolver, without an acceptance-only binary override.
The gate also requires the official CLI to acknowledge this exact task
(Claude's matching first-prompt UUID echo or Codex's `turn/start` ACK), plus a
complete run-bound HTTP receipt with no extra execution-time authorization or
provider-proxy calls. Process startup and `system/init` cannot satisfy it.
Installation preserves every original persistent entry exactly. E2B's final
boot and a disposable fresh instance are checked separately against the
recorded exact-path provider-runtime policy; original CLI/software bytes and
all other fields remain protected. File-scan verification instances are never
reused as cold-start performance samples.
The finalizer always closes instances labelled with this exact source, run and
attempt. A failed build, obsolete source, failed Web wait or subscription gate
also removes this run's exact named private candidates and verifies their
absence. Public images and previous releases remain available. Cleanup receipts
are artifacts; a cleanup error fails the workflow. After a failed release, rerun
all jobs to rebuild candidates, since a failed-jobs-only rerun would refer to
candidates that the finalizer has already removed.

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
`SMOKE_OWNER_EMAIL` / `SMOKE_OWNER_PASSWORD` from `prod:/`, signs in normally, uses
tasks titled “测试” in `alexj11324/Mikka-handoff`, then removes its own fixtures.
Publication uses `VERCEL_TEAM_TOKEN` from `prod:/platform`. Delivery uses the
existing GitHub OIDC identity; credential values never enter reports or logs.

The worker digest excludes unrelated Web lock entries and package scripts.
Every main push compares that wanted digest with the published production
digest. Matching digests reuse the release. After a failed publication, a
documentation-only push can still rebuild and revalidate the unpublished worker. The existing no-new-polling rule
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
publish from a red PR. The workflows bootstrap the trusted Nx selector from
`origin/main` and the immutable base; documentation-only PRs still publish their required gate names.
CI source changes are not classified as documentation-only.

## Official UI overlay

There is one UI ([decision](../../docs/design/decisions/2026-11-08-2133-one-ui.md)).
Public and fork PRs build without the private repository, and that build only
has to compile; no workflow screenshots it. (`community-settings-ui.yml`,
which captured that build's settings pages, was removed on 2026-11-08.)

`web-deploy.yml` and `desktop-release.yml` alone read the private UI through
Infisical OIDC and `HOSTED_UI_READ_KEY` (`prod:/platform`, GitHub read-only deploy key on
`alexj11324/mikka-hosted-ui` only). They set `MIKKA_UI_OVERLAY_DIR` and record
`MIKKA_UI_OVERLAY_SHA`; public and fork PRs still build with the default slots
without either variable or any private secret. The production Web job checks
public main plus private main on each main update, including docs-only pushes. Private main pushes dispatch
the official Web job again with `overlay-refresh: true`, so docs-only changes
cannot skip an overlay rebuild; bundled UI/release input changes also dispatch desktop with the expected
overlay SHA, while private documentation-only pushes refresh Web only. No schedule is involved.

Web verifies `/mikka/api/version`'s `build` and `overlaySha`. Desktop uses the
existing matching-Web source gate and checks out **that Web overlay SHA**, then
verifies equality again before publishing. New desktop preflights replace older
Web waits. The macOS job finishes its active signing/notarization work and keeps
only the latest pending candidate; new main pushes do not cancel a signed build
in progress. Before publication, an overlay that no longer matches production is
rejected, and the existing proven-Web-descendant and sealed-candidate checks still
apply.
Desktop seals, verifies and publishes from one macOS job with no public Actions
artifact upload. Release assets include the sealed `mikka-ui-overlay.json`.
Official compiler logs stay on the ephemeral runner, and both distributable
static output and the complete signed ASAR are audited for source maps.
See [the deployment runbook](../../docs/operations/web-deploy.md#official-private-ui-overlay)
for identities, rollout, source exposure boundaries and recovery.

## Dependency-aware selection

`ci-selection.yml` supplies the same trusted decision to CI, Analytics SSR,
Desktop and Self-hosted image. Nx Core follows explicit root-file, workspace,
source-contract and DB feature-marker edges; candidate code is parsed, not
executed during classification. Source/security policies stay enabled, and
unmapped/unsafe/global inputs expand coverage. Core/integration commands are
scheduled by Nx; the existing strict database runner owns selected PG17 suites.
When the immutable base predates the selector, full blocking coverage and
shadow selection apply. A selector absent from that base cannot authorize a skip. Manual dispatch
and Monday 03:23 UTC run complete CI. No Nx Cloud, remote test cache, browser E2E
or release credentials are added. See [policy and commands](../../docs/ci/incremental.md)
and [measured results](../../docs/ci/1699-results.md).

Selected Desktop, Analytics and Docker PR checks now run as reusable jobs of CI;
their conclusions are included in `UI policy (strict)`. Main image publication
remains independent, and source-SHA release gates are unchanged.
