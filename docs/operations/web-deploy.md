# Production web deploy

Production builds of the web app run on GitHub Actions, not on Vercel's build
machines. Mikka is a public repository, so GitHub's standard runners are free,
while each Vercel build cost about 5 minutes of a 4-core machine, around 100
times a day. Vercel still hosts the deployment and serves `app.aspectlylabs.com`.

## Flow

`.github/workflows/web-deploy.yml` runs on every push to `main`, on manual
dispatch, and as the reusable build for a verified official runtime refresh.
Its deploy job holds `web-deploy-production` through environment publication,
build, upload and public-version verification. `queue: max` retains pending
jobs instead of allowing a late old runtime refresh to replace a queued new
main deploy. The queue orders jobs by when they start waiting, not by commit
order; source guards reject jobs whose full SHA is no longer current `main`.
See [GitHub's concurrency contract](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

1. **Source and token.** Checks the current `main` SHA before release work,
   then reads `VERCEL_DEPLOY_TOKEN` from Infisical `prod:/platform`
   through the existing GitHub OIDC identity. This is a dedicated Mikka-team
   token, so it can be rotated without touching `VERCEL_TOKEN` or
   `VERCEL_TEAM_TOKEN`. It expires on 2027-02-02.
2. **Skip.** Applies the same documentation-only rule the old Vercel Ignored
   Build Step used (`scripts/vercel-ignore-build.mjs`). The comparison is
   against the commit production serves now, not the previous push, so a
   failed deploy is never skipped over.
3. **Environment.**
   - `vercel pull` fetches project settings and the production environment.
     Vercel returns sensitive values empty.
   - The job reads `prod:/vercel` from Infisical. This is the source that
     Vercel production is synced from.
   - `scripts/release/web-deploy.mjs env` fills only the keys that production
     defines and Vercel withheld. It pins `VERCEL_GIT_COMMIT_REF=main` and the
     commit SHA, which the migration guard requires.
   - It refuses to build if a required value is missing. The error names the
     variable, never its value.
4. **Build.** Runs `vercel build --prod`, which is the same `pnpm build` as
   before, ending with typecheck and then migrations against the production
   database.
5. **Deploy.** Rechecks current `main` immediately before
   `vercel deploy --prebuilt --prod`. The Git metadata (org,
   repo, ref, SHA) lets the device gateway release
   (`docs/operations/device-gateway-release.md`) identify the serving commit.
6. **Verify.** Before releasing the queue, requires the unauthenticated public
   `/mikka/api/version` response's `build` to equal the complete commit SHA.

The deployment's runtime environment comes from the Vercel project as before.
The workflow uploads build output only.

`vercel.json` keeps `git.deploymentEnabled.main` off, so Vercel does not also
build each push.

## Skew Protection

A page left open across a deploy keeps calling its own build's Server Actions.
Without Skew Protection the new deployment answers them with "action not
found", and `watchRemovedActions` in `lib/app-build.ts` reloads the page.

A prebuilt upload has no Vercel deployment id at build time, so the workflow's
**Choose the deployment id** step sets `MIKKA_DEPLOYMENT_ID` from
`lib/deployment-id.mjs`: `<first 12 of the sha>-<run id>-<run attempt>`, at
most 32 characters, never starting with `dpl_`. Each run attempt gets a new id,
because Vercel fails a deploy that reuses one. `next.config.mjs` sets
`deploymentId` from it, and `experimental.runtimeServerDeploymentId: false`
so pages keep this id instead of the runtime `dpl_` id
([vercel/next.js#94734](https://github.com/vercel/next.js/issues/94734)).
Next.js 16 then sends it as `x-deployment-id` on Server Action and RSC
requests. Local builds and CI checks leave it unset.

The id does nothing until Skew Protection is on for the Vercel project. Turn it
on in the dashboard: Project Settings → Advanced → Skew Protection. The API
returned "Skew Protection not found" for this project, so the dashboard toggle
comes first, and it may need the Pro plan. `watchRemovedActions` stays as the
fallback for pages older than the Skew Protection window.

## Official runtime configuration

The official runtime workflow keeps its existing disposable-instance validation,
worker hash, measured model catalogue and unchanged-file proofs. After validation,
a read-only job waits up to 40 minutes for the same source's latest Web run to
succeed, including its actual build/upload/version steps, and for the public
version to match. A docs-only skipped build cannot satisfy this gate. If `main`
advances, the old release stops. This wait is outside the shared deployment queue
so it cannot block the Web job it is waiting for.

Changes to the two release workflows, `scripts/release/web-deploy.mjs` or
`scripts/e2b/publish-template-env.mjs` also require the full runtime validation
and reusable publication, even when the worker hash is unchanged. The check
compares the actual complete push (`github.event.before` to `github.sha`) with
full history; missing or invalid endpoints fail instead of counting as unchanged.
These four paths are all in the runtime workflow's push filter. Documentation
and test-only changes do not force paid instance validation.

The E2B caller itself also uses a distinct `queue: max` group, so an old rerun
cannot discard a newer main's pending validation before it reaches Web deploy.
The check rejects obsolete main jobs before reading release credentials or
starting instance validation. PRs keep their separate group and only run offline
tests; retaining their pending runs replaces the previous cancellation behavior
at the cost of possibly running an obsolete, short offline test job.

The runtime workflow then calls `web-deploy.yml` at its own commit with
`runtime-refresh: true`. Inside the shared deploy job, the original Infisical
identity reads the existing `VERCEL_TEAM_TOKEN`. The publisher verifies current
`main`, the production alias and public version, reads the six runtime values,
checks `main` again, and submits at most one environment upsert followed by exact
readback. The ordinary GitHub build and prebuilt upload follow in that same job.
The publisher does not create a Vercel deployment or request a source rebuild.

If env publication succeeds but the later build fails, use Actions' **Re-run
failed jobs** on that runtime run while its source is still current `main`. It
reuses the successful validation outputs. The explicit runtime refresh builds
even when the env values already match; it also bypasses the docs-only skip.
An uncertain environment POST is never automatically retried. A failed-job rerun
reads back before deciding whether one new upsert is needed. Re-running the
entire runtime workflow with the default inputs is different: its initial
worker-hash comparison can skip validation/publication when the env hash already
matches. For a full refresh or a release-pipeline acceptance, manually dispatch
**E2B official instance runtime** on current `main` with `runtime-refresh: true`
after its Web run and public version match. That explicit option only bypasses
the unchanged-hash optimization; it runs the official-instance validation again
and preserves all source, measured-model, queue and readback checks. It defaults
to false, so ordinary unchanged pushes keep their existing skip behavior.

The source fences and queue protect application upload order; they do not make
the Git ref and Vercel environment one atomic transaction. A newer push during
the build prevents the obsolete upload. Its normal main release proceeds next.

## Logs are public

Actions logs on this repository are public. Infisical values are masked by the
action, and `vercel pull` output is discarded. Do not add steps that print the
environment or `.vercel/.env.production.local`.

## Rollback

Fix forward in a new PR, or revert through a PR. The resulting `main` commit
uses the same GitHub build, prebuilt upload and public-version verification.
Do not restore Vercel source builds, delete deployments or revoke shared tokens
as a recovery step.
