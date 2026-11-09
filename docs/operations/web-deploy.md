# Production web deploy

GitHub Actions builds the shared Vite frontend and independent Nitro API.
Vercel hosts their Build Output API artifact and serves `app.aspectlylabs.com`.

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
   `VERCEL_TEAM_TOKEN`.
2. **Build selection.** Every main push builds public main plus private main,
   including documentation changes, so the private/public compatibility check
   covers every main update. Manual overlay/runtime refreshes also always
   build. Ordinary manual dispatch retains the documentation-only rule
   (`scripts/vercel-ignore-build.mjs`), comparing with the source production
   serves now rather than the previous push.
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
4. **Build.** Runs `node scripts/release/build-vercel.mjs`. The wrapper requires
   Node 24, pnpm 10.34.3, the exact checked-out SHA and a unique deployment ID.
   It selects `NITRO_PRESET=vercel` and runs the normal `pnpm build`: subscription
   worker, agent UI generation, Vite frontend, Nitro API, typecheck, then
   migrations against the production databases. It checks the resulting
   `.vercel/output/config.json`; it does not invoke `vercel build` or Next.
5. **Deploy.** Rechecks current `main` immediately before
   `vercel deploy --prebuilt --prod --archive=tgz`. The Git metadata (org,
   repo, ref, SHA) lets the device gateway release
   (`docs/operations/device-gateway-release.md`) identify the serving commit.
6. **Verify.** Before releasing the queue, requires the unauthenticated public
   `/mikka/api/version` response's `build` to equal the complete commit SHA.

The deployment's runtime environment comes from the Vercel project as before.
The workflow uploads build output only. The local acceptance switches
`MIGRATE=0` and `MIKKA_BUILD_BYOS_WORKER=0` do not prove the production migration
and worker build; keep the normal production settings for this release path.

`vercel.json` sets `framework: null` (Other), overriding the dashboard framework
preset, and keeps Git-triggered deployments disabled. The prebuilt workflow
therefore needs no Vercel source build or second dependency installation. See
[the framework override](https://vercel.com/docs/project-configuration/vercel-json#framework)
and [prebuilt uploads](https://vercel.com/docs/cli/deploy#prebuilt).

`apps/api/scripts/finalize-build.mjs` preserves Nitro and Workflow function
metadata, requires Node 24, adds the tracing entry before the application,
and copies the runtime resources. `.vercel/output/mikka-build.json` records
the source SHA, function contracts and resource hashes. These build checks do
not prove hosted queue delivery or production OAuth callbacks.

Keep **Automatically expose System Environment Variables** enabled in the
existing project. Workflow uses the platform's runtime `VERCEL_DEPLOYMENT_ID`,
project ID, OIDC and encryption configuration; the custom client deployment
ID below does not replace them. Production must not inherit the local
`WORKFLOW_TARGET_WORLD=local` or `WORKFLOW_LOCAL_*` configuration. See the
[Workflow Vercel World contract](https://workflow-sdk.dev/worlds/vercel#system-environment-variables).

## Skew Protection

A page left open across a deploy must load its remaining assets and call the
API from the same deployment. The shared frontend implements these pins
explicitly; it does not rely on Next's Server Action or RSC transport.

A prebuilt upload has no Vercel deployment id at build time, so the workflow's
**Choose the deployment id** step sets `MIKKA_DEPLOYMENT_ID` from
`lib/deployment-id.mjs`: `<first 12 of the sha>-<run id>-<run attempt>`, at
most 32 characters, never starting with `dpl_`. Each run attempt gets a new id,
because Vercel fails a deploy that reuses one. The build writes the same value
to `.vercel/output/config.json`'s `deploymentId` and the frontend bundle:

- `apps/frontend/scripts/deployment-plugin.mjs` adds `?dpl=` to the HTML's local
  asset links and emitted JavaScript and CSS asset references, including lazy
  chunks. The renderer-build module URL uses the same ID.
- `apps/frontend/src/web/deployment-fetch.ts` adds `x-deployment-id` to browser
  fetches for the same origin's `/mikka/api/*` routes, including JSON RPC.
- `/mikka/api/version` deliberately has no deployment pin. The existing
  `VersionGuard` and explicit-action build checks can therefore detect a new
  public build and require refresh. Full document navigations load the current
  deployment.

Vercel supports custom IDs for the
[Build Output API](https://vercel.com/docs/skew-protection#build-output-api).
The project's Skew Protection setting must still be enabled for the platform
to honor the pins. Verify that setting and its retention window on the actual
project; the presence of pins in a local artifact is not a platform routing
test. Builds without `MIKKA_DEPLOYMENT_ID` omit the pins; the production wrapper
requires it.

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

## Official private UI overlay

Builds without `mikka-hosted-ui`, including every public/fork PR check, leave
`MIKKA_UI_OVERLAY_DIR` unset and use the public slot implementations. Only the
trusted `main` official release jobs check out `alexj11324/mikka-hosted-ui`.
They read `HOSTED_UI_READ_KEY` from Infisical `prod:/platform` with the existing
GitHub OIDC identity. This is a GitHub
**read-only deploy key**, registered on **mikka-hosted-ui only** (`read_only:
true` verified through the repository API); it is not a public-repository
secret. The existing native-runner administration identity used for one-off
registration is never delivered to public build jobs.
Checkout uses SSH without persisting credentials in Git configuration. The
record step clears the key from subsequent job steps before any build runs.

Web checks out private `main` into ignored `.hosted-ui/`, records the exact
commit in `MIKKA_UI_OVERLAY_SHA`, then exports `MIKKA_UI_OVERLAY_DIR` before
building. Private runtime dependencies are installed with `--ignore-workspace
--prod --ignore-scripts --frozen-lockfile`: the library remains standalone and
its license-writing postinstall never runs. Install diagnostics stay on the
ephemeral runner. Nitro inlines that SHA into `/mikka/api/version` as `overlaySha`;
Vercel deployment metadata also records `mikkaUiOverlaySha`. An open-source
server reports `overlaySha: null`. Runtime Vercel environment changes cannot
mislabel a previously built overlay. After upload, the public route must match
both the public source and the overlay before the Web queue is released.
The existing runtime-refresh caller follows the same official build path.

The disposable official Linux runner removes only its unused preinstalled
Android, .NET and GHC SDKs before the build. It retains the workspace,
dependencies, Node/pnpm and Docker resources. The build uses a 4096 MB V8 heap;
the original compile, typecheck and migration sequence remains unchanged.
Filesystem space/inode counts and aggregate function-output size are recorded
without listing private output files or emitting compiler diagnostics.

Private `main` pushes trigger its `official-mikka.yml`. Through the same
Infisical identity (bound to the private repository's numeric ID and immutable
main subject) it reads the existing dispatch identity at `dev:/github/GH_TOKEN`
and dispatches Web with `overlay-refresh: true`, bypassing the documentation
skip. No scheduled polling is used. Every public main build and private push
therefore validates the combination of public main and private main; external
PRs need no private access. The private workflow also dispatches the normal
official desktop release when bundled UI or release inputs change. Private
documentation-only pushes refresh Web without publishing an installer; manual
private workflow dispatches release both, following the existing desktop rule.
During the initial rollout it detects an unmerged public pipeline and makes no
production change.

Desktop preflight waits for the successful production Web build using the
existing source-compatibility gate, then reads its overlay SHA. macOS checks
out that exact private commit rather than moving private main. A private-push
dispatch also requires Web to serve that push's overlay before selection.
Before release, the source gate and overlay equality run again. The signed
installers, SBOM, checksums and `mikka-ui-overlay.json` are sealed, verified and
published in the **same macOS job**; no Actions artifact transports a paid
bundle between jobs. The latter JSON is covered by the existing release
manifest digest and is also embedded in the signed app’s `dist/` for inspection
after installation. Existing signing, notarization and skip-notarization draft
rules still apply. A new preflight cancels an obsolete Linux Web wait. macOS
signing/notarization runs one candidate at a time, preserves an active signer,
and keeps only the latest pending candidate. This lets a valid signed build
finish when a newer Web contains its source. Before waiting on that Web at
publication, a changed production overlay rejects the old installer immediately;
the normal Web-source proof, final overlay equality and sealed-candidate checks
remain required. Do not classify two Web runs as duplicates from the public SHA
alone: their recorded overlay SHAs may differ.

### Public output boundary

- No official workflow uploads private source, build logs, renderer graphs,
  Web output or desktop bundles as GitHub Actions artifacts. Only the intended
  compiled Web assets go to Vercel; signed installers go to GitHub Releases.
- Official compiler diagnostics are captured on the ephemeral runner, because
  errors may quote private source. They are neither printed nor uploaded.
  A failed build emits only a closed receipt: public and overlay revisions,
  exit status, allowlisted signal/error codes, the last observed public build
  phase, and protected-log byte count/SHA256. The phase can be `unknown`, and
  SIGKILL alone is not an OOM diagnosis. No raw output, message or stack is emitted.
  `processErrorCode` describes only a process-launch error. The independent
  `observedSystemCode` records the last allowlisted system-code candidate in a
  protected child-log `code` property or standard `Error: CODE:` header, including
  when the child exits nonzero without a launch error. It is an observation, not
  proof of the terminating cause; absent or unrecognized codes remain `null`.
  No associated message, path or source line is included.
  `lastTypecheckCommand` observes only the fixed root/API combined command or
  frontend command; it does not distinguish which root/API compiler failed.
  `typescriptCodes` contains at most 16 unique diagnostic identifiers, without
  filenames, source or error messages. The fixed `migrate: starting` marker
  observes entry into a requested migration command before its guards; it does
  not prove any SQL ran. An explicit `MIGRATE=0` skip does not emit that marker.
- The live Web builder is Vite + Nitro, both with `sourcemap: false`;
  `next.config.mjs` is a legacy path, not the production compiler. Before
  upload, `hosted-ui.mjs audit` checks Vercel's public static tree for raw UI
  source, `.map`, inline source-map directives and `sourcesContent`.
- The desktop production renderer and main/preload emit no source maps.
  Installers include their bundled `dist/` and package metadata, explicitly
  excluding hoisted workspace `node_modules/` and its development source/maps.
  After signing, the complete actual ASAR is extracted and audited
  before publication. The private checkout remains outside the package.
- Do not print environment files, credentials or private source while debugging.
  Rotate a checkout key through Infisical and the same repository’s read-only
  deploy-key registration; never broaden its repository or permission scope
  to get a build through.
