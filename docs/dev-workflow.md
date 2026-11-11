# Development workflow

Standing rules for how work moves from a branch to `main`. Decision:
[`2026-11-01-1440-dev-workflow-local-first`](design/decisions/2026-11-01-1440-dev-workflow-local-first.md);
ownership as Alex set it on 2026-11-03, with batch merging updated on
2026-11-05 (§ 5).
Use `AGENTS.md` and the accepted decision hierarchy when another document
disagrees, then update the lower-priority document.

## 1. Local first

Build, run the services and the daemon, and do end-to-end acceptance locally,
in the session's own cloud Linux container. A pull request can be opened at
any time, and opening one never waits for, or stops, local building and
verification.

CI is the final gate, not the place to find out whether something works.
Nobody sits waiting on CI, a merge or a deploy to check what can be checked
locally. Push, open the PR and keep working; read CI when it reports.

Ordinary acceptance follows [`acceptance.md`](acceptance.md): a local
application, a real isolated database and, when the flow uses one, a real
daemon. Ordinary acceptance goes through the API and CLI
(`pnpm test:local-loop`, [local-runtime.md](local-runtime.md)), and a UI change
is checked with screenshots of a local production build of the official UI
(this repository plus `mikka-hosted-ui`, [one UI](design/decisions/2026-11-08-2133-one-ui.md)) under
[1520](design/decisions/2026-11-01-1520-no-browser-tests-in-ci.md) and
[2225](design/decisions/2026-11-01-2225-api-cli-acceptance-and-backend-owner.md).
The general browser suite is retired. Retained targeted Desktop, Analytics and
self-hosted jobs keep the scopes in the
[workflow reference](../.github/workflows/README.md).

## 2. Hot reload

Debugging and pipeline runs use source with hot reload.

| Part | Command |
| --- | --- |
| Web application and API | `pnpm dev` (`apps/api/scripts/dev.mjs`, Vite + Nitro) |
| Daemon | `pnpm daemon` (`tsx` on `packages/daemon` source) |

Vite serves the frontend and proxies API requests to Nitro's development
worker at the same origin. The API uses Hono, and the Workflow runtime uses
the local world. Development state lives under `.cache/dev-runtime/<port>/`.
The default origin is `http://localhost:3000/mikka`.

For production screenshots of a UI change, run
`NITRO_PRESET=node-server pnpm build:app`, then `pnpm start` in cloud Linux
with the isolated database configured. The build
emits the Vite frontend and Nitro Node server into `.output`. Startup validates
`.output/mikka-build.json` and serves the compiled application. Node 24 is
required. `pnpm build` also builds the subscription worker, generates the Agent
UI, runs type checks and invokes migrations. The official Web workflow builds
with `NITRO_PRESET=vercel` into `.vercel/output` through
`scripts/release/build-vercel.mjs`.

`vercel.json` installs every workspace except `@mikka/mobile`, which the Web
build does not use. Runtime and frontend build configuration lives in
`apps/api/nitro.config.ts` and `apps/frontend/vite.config.mjs`.

## 3. Environment

One command sets up a container: `eval "$(scripts/dev/bootstrap-local.sh)"`
([local-bootstrap.md](local-bootstrap.md)). Put it in
the cloud environment's setup script so every session starts ready. It
provides:

- **Node 24**, the version family required by the runtime and CI. The separate
  Node 22 compatibility workflow covers its selected source tests only.
- **PostgreSQL 17** at `127.0.0.1:5432`, database `mikka_e2e`; migrations with
  `pnpm migrate` (it runs by itself when every target is a loopback database;
  a remote database off Vercel still needs `MIGRATE=1` and `--allow-remote`).
- **Chromium** for UI screenshots: the container's
  `/opt/pw-browsers/chromium`. Never run `playwright install`.

`dev:local` retains its DeepSeek Flash setup. Its paid API-key path does not
gate acceptance or a merge. Live model acceptance follows the two subscription
paths in [acceptance.md](acceptance.md#live-model-acceptance). See the
[local model setup](local-runtime.md#which-model-local-runs-use) for the
existing harness's limits.

The required CI database matrix initializes its disposable PostgreSQL 17 service
with `max_locks_per_transaction=512`. Four package lanes, each with concurrent
test files, can tear down several full-migration schemas at once. PostgreSQL's
lock table is shared across databases, so separate suite clones still compete
for it; the default 64 can fail `DROP SCHEMA ... CASCADE` with SQLSTATE `53200`.
This startup setting increases CI lock-table capacity without reducing test
parallelism or bypassing cleanup. It does not change application or production
database configuration.

Signup limits never block local work. In local test-account mode
(`localTestAccountsMode`, `scripts/test-accounts/database-target.mjs`) and
outside Vercel, the signup and verification limits default to CI's (1000 per
IP and 10000 overall each hour, instead of 5 per IP), and Better Auth's
sign-up rule rises from 3 to 100 per 10 seconds (`lib/abuse/signup.ts`). This
holds for `pnpm dev` and `pnpm start` alike. A limit set explicitly
(`MIKKA_SIGNUP_*_HOURLY`, `MIKKA_VERIFICATION_*_HOURLY`) still wins;
production is unchanged.

## 4. CI variables

Never set `GITHUB_ACTIONS`, `RUNNER_ENVIRONMENT`, `GITHUB_RUN_ID` or any other
CI variable to get past a test guard. A suite that runs only on a
GitHub-hosted runner is left to CI.

Database suites decide by the database, not the runner: they run wherever every
application database URL is a loopback `*_e2e` database
(`disposableDatabase` in `tests/helpers/e2e-target.mjs`) and skip or refuse
otherwise. The shared test-account bootstrap supports local mode and
GitHub-hosted CI, plus a separately bound Docker bootstrap
(`scripts/test-accounts/bootstrap.mjs`). Its CI entry requires
`GITHUB_ACTIONS`. Local mode uses its own disposable-database and revision
checks. These account-pool guards also apply to any retained targeted consumer.
The general browser suite is retired, while targeted jobs retain their
source-bound scope in the [workflow reference](../.github/workflows/README.md).

Local test accounts: the local mode (`MIKKA_LOCAL_TEST_ACCOUNTS=1` with a
loopback `*_e2e` database) is described in
[`test-accounts.md`](test-accounts.md#local-mode-a-developers-own-disposable-database).

## 5. Ownership and merging

Alex set the ownership rules on 2026-11-03
([`2026-11-03-2359`](design/decisions/2026-11-03-2359-issue-owner-merges-and-accepts-in-production.md)).
Batch merging follows Alex's 2026-11-05 update in `AGENTS.md`.
They replace the coordinator-merges rule, the push-fixes-to-main rule and the
old module owners (backend was Codex's).

1. **One owner.** Work is assigned through a GitHub issue to one agent
   (currently ChatGPT Pro sessions; earlier Codex and Cursor). That agent
   owns it end to end: code, PR, merge, deploy check and production
   acceptance. It resolves every blocker itself and keeps going until the
   goal is met in production, without stopping to wait for anyone (Alex,
   2026-11-05). When Alex grants an owner full permissions on its issue,
   that grant overrides the limits in this document for that issue.
   Full permissions are for finishing the goal, not for spending: size
   machines and paid resources to the actual need and stop each one as soon
   as its step is done.
2. **No direct pushes.** Nobody pushes to `main`. Every change goes through a
   PR from a branch based on `main`. Each original PR changes one thing;
   ready PRs are integrated as a batch under rule 3.
3. **The owner merges.** Each PR is merged by its owner, the agent that
   leads its issue (Alex, 2026-11-05). A Pro owner always has the right to
   merge its own PRs on its own: when CI is green on the latest head and the
   PR is mergeable, it merges, without waiting for or handing the PR to
   anyone. When the owner has two or more of its own PRs ready, it combines
   their branches into one `batch/<date>-<n>` branch, resolves conflicts once
   and runs CI on the final batch head, then merges the batch PR with a merge
   commit so the original PRs are recorded as merged. Each original issue
   keeps its owner and production acceptance criteria. A single ready PR may
   be squash-merged. A UI change merges only after the owner has reviewed its
   screenshots and attached them to the PR.
   A change to auth, signup, privilege or credentials says so in the PR.
4. **Stacked PRs** merge in order. After a base merges, retarget the next PR
   to `main`.
   Do not merge `main` into a PR only to keep it current: branch protection
   does not require an up-to-date branch, and each merge reruns the full CI.
   Merge `main` in when there is a conflict, or when a change that just landed
   touches the same code and the PR must be checked against it.
5. **After the merge** the owner watches the Vercel production deployment
   until it is READY and the production domain serves that commit. After a
   batch lands, leave `main` unchanged until both conditions hold. Pending
   migrations run through the existing flow (`pnpm build` runs
   `scripts/migrate.mjs`). A change a local production build can show (UI,
   interaction, navigation, page refresh, layout, copy) is accepted by CI
   and the PR's screenshots; the owner notes on the issue that production
   serves the merge commit and closes it. Only what cannot be tested
   locally (real subscriptions, OAuth, model providers, the GitHub App,
   payments, push and other external services) is accepted in production,
   with the shared test account and a real task (no junk data; see
   [`acceptance.md`](acceptance.md)). A simulated test is not production
   acceptance. The owner writes the evidence on the issue (time, run id,
   log summary; no secrets or personal data) and closes the issue. Every
   production Web deploy also triggers the implemented API smoke. The required
   message/task smoke remains a documented coverage gap in
   [production smoke](production-smoke.md).
   A PR that touches only `apps/mobile/**` and documentation is the
   exception: it merges once CI is green and it is mergeable, without
   waiting for Web deploy or E2B to be idle. Its push still queues a Web
   build (`queue: max`, `cancel-in-progress: false`) that rebuilds unchanged
   web output, so the owner watches only the Mobile OTA run and reports its
   update group ID.
   It still does not merge while an E2B runtime release is in progress or
   awaiting Web: that release is bound to the exact `main` SHA, so moving
   `main` fails it with `mainChanged` and forces a rebuild. It also respects
   any merge window an owner has posted on a PR or issue.
6. **If production breaks,** fix forward with a new PR, or revert through a
   revert PR. Never delete deployments, revoke shared tokens, change
   production Neon settings or create paid resources without Alex.
7. **The coordinator** (a Claude Code session) writes issues, reviews and
   verifies. It merges only the PRs it leads itself; every other PR is merged
   by its own owner. Review findings go on the PR as comments for the owner.
8. A documentation conflict is resolved by whoever merges: they edit the
   documents directly.

Before any merge, verify the affected API/CLI flow and required CI checks.
UI changes also need screenshots of a production build of the official UI
(`pnpm build:app`, `pnpm start`, with `mikka-hosted-ui`) in a cloud Linux or Docker sandbox, against its
own isolated PostgreSQL database (`mikka_e2e`). Isolated screenshot harnesses
use their leased owner/peer fixtures ([`test-accounts.md`](test-accounts.md)).
Shared-team and external-service acceptance follows the shared SMOKE account
contract in [`acceptance.md`](acceptance.md). Pull requests and branches have no Vercel Preview: every build
runs on GitHub Actions, and only `main` deploys, to production
([decision 2026-11-05-1632](design/decisions/2026-11-05-1632-no-vercel-preview.md)).

## 6. Rule IDs and migrations

The coordinator assigns rule IDs (`R-xx`) when it writes the issue. Migration
IDs are generated automatically, following the
[Rails-style migration decision](design/decisions/2026-11-11-1151-automatic-migration-ids.md).

To add a database migration:

1. From the repository root, run `pnpm migration:new add_project_notes`.
   It creates `drizzle/YYYYMMDDHHMMSS_add_project_notes.sql`.
2. Write the SQL in that file. The generated header targets
   `MIKKA_DATABASE_URL`; use `-- target: DATABASE_URL` for the workspace database.
3. Run `pnpm check:migrations` and `pnpm test:migrations`. Verify the SQL against
   an isolated database, covering both a fresh replay and an upgrade from the
   preceding deployed schema.

The generator takes the later of the current UTC second and the latest local
migration ID plus one second. It reserves IDs atomically across this clone's
Git worktrees and advances automatically on a collision, including concurrent
invocations. There are no Agent ranges or manually allocated timestamps.

The runner sorts pending files and checks each full filename against that
database's `schema_migrations` ledger. A missing file runs even if its timestamp
is older than an already executed file. Independent branches can merge in
either order without renumbering; SQL dependencies still need to merge first.

Keep inherited `main` migrations and every executed migration under their
original names with their original SQL. Add a corrective migration for changes.
The checker rejects malformed or duplicate IDs and changes to inherited history.
Independent clones can still collide: regenerate an unexecuted migration with
the command before merging, while retaining every executed file. Existing
historical aliases and transaction rules remain in force.

## 7. E2B templates

Build versioned Mikka templates on top of E2B's official `desktop`, `claude`
and `codex` templates. All preinstalled Mikka software lives under `/opt/mikka`.
The official CLI packages, Node/npm, system files and their layout remain
intact: adding files is allowed; deleting or overwriting originals is not
([Alex's #1505 clarification](design/decisions/2026-11-03-1430-official-e2b-templates-unchanged.md)).

A worker change on `main` runs `e2b-official-runtime.yml`, using the reusable
`e2b-template.yml` candidate builder. The build checks every protected original
file's hash, type, mode, owner and link before and after installation. Both
Claude Code and Codex must complete real subscription executions on those
candidates before public publication and production selection. Credentials
arrive through normal device enrollment and owner/run-bound subscription
leases; templates contain no identity or credential.
The final E2B boot has a separate, recorded check for only the provider-owned
runtime fields established by the official-only control experiment; see the
decision's exact-path policy. A fresh verification VM is destroyed before
creating any timed sample, so the file scan cannot warm the measured VM.
Production, model probes and subscription acceptance share the release's CLI
manifest and resolver. A retained VM receives that manifest with its staged
worker release; activating or rolling back the worker selects the matching
manifest without rebuilding its repository or session.

The publication uses Web deploy's production queue and exact-source checks.
Each build gets a unique name; retain old templates and save the previous
paired configuration in `MIKKA_CLOUD_RUNTIME_PREVIOUS`. For rollback, use the
normal rollback PR and release gates to restore matching application and worker
code, using that retained configuration as the previous known-good target;
the old source receipt cannot bypass the exact-main check. Do not change
template aliases or Vercel production variables by hand. A failed candidate
gate leaves production on its existing templates. The single configuration
upsert is checked by per-variable readback; a partial write requires repair
and revalidation and never replaces a valid previous configuration. See the
[release workflow](../.github/workflows/README.md#cloud-worker-template-release).
An always-run finalizer kills this attempt's labelled test instances and deletes
its exact private candidates after any failure, with readback and cleanup
receipts. Public and previous images remain. Rerun the full workflow after a
failed release so the removed candidates are rebuilt.

## 8. Reaching a local service from outside

Identify the current environment's supported ingress before exposing a local
service. The issue-owned Docker adapter uses a verified HTTPS publication
([Docker environment](operations/desktop-docker-test-environment.md)). Earlier
managed cloud sessions allowed outbound traffic only through a port-443 proxy,
which blocked `cloudflared` on port 7844. Recheck that network boundary in the
current session and record the actual failure. Keep production credentials in
their existing delivery environment.

## 9. Parallel work and stalls

- Independent work runs in parallel, with subagents.
- A step that makes no progress for 5 minutes is stopped: change the approach,
  or move it to the background with a timeout.
- When the cause is unknown, and before any fix, read the tool's official
  documentation and put the link in the report.
- Run long commands (builds, full suites, starting the dev server) in the
  background with a notification and an explicit timeout. No foreground
  `sleep` loops and no polling of log files.

## 10. Do, then report

Do not sit idle waiting for the coordinator. Anything within these rules,
do it first and report after. Only real decisions (product direction,
permissions, production changes) wait for an answer. Every report includes
the next step you are taking, so the coordinator does not need to reply
before you continue.

## 11. CI is not a pause

While CI runs, start the next task. When there is none, ask for one in the
same message as the report.
