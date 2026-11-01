# Development workflow

Standing rules for how work moves from a branch to `main`. Decision:
[`2026-11-01-1440-dev-workflow-local-first`](design/decisions/2026-11-01-1440-dev-workflow-local-first.md).
Where another document disagrees, this page wins; fix the other document.

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
daemon. CI runs no browser tests at all
([decision 2026-11-01-1520](design/decisions/2026-11-01-1520-no-browser-tests-in-ci.md)):
browser specs run locally, and a UI change is checked with screenshots of a
local production build.

## 2. Hot reload

Debugging and pipeline runs use source, not builds:

| Part | Command |
| --- | --- |
| Server | `pnpm dev` (`next dev`, via `scripts/dev-preview.mjs`) |
| Daemon | `pnpm daemon` (`tsx` on `packages/daemon` source) |

Use a production build (`next build` then `next start`) only for production
screenshots of a UI change, or for a spec that requires one. Run `next build`
directly (`pnpm exec next build`): `pnpm build` also runs lint and migrations.

现状（非决定）：`playwright.config.ts` and `scripts/start-mvp-e2e.mjs` still
start `next start`, so those specs need a build until they move to `next dev`.

## 3. Environment

One command sets up a container: `eval "$(scripts/dev/bootstrap-local.sh)"`
([local-bootstrap.md](local-bootstrap.md)). Put it in
the cloud environment's setup script so every session starts ready. It
provides:

- **Node 24**, the same as CI. Node 22's `mock.module` ignores `{ exports }`
  and gives false test failures.
- **PostgreSQL 17** at `127.0.0.1:5432`, database `mikka_e2e`; migrations with
  `pnpm migrate` (it runs by itself when every target is a loopback database;
  a remote database off Vercel still needs `MIGRATE=1` and `--allow-remote`).
- **bubblewrap, socat and ripgrep** for the daemon's sandbox and tools.
- **Playwright** on the container's Chromium: set
  `executablePath: '/opt/pw-browsers/chromium'`. Never run
  `playwright install`.

Local runs use DeepSeek DS 4.1 Flash through the workspace's own key
(`DEEPSEEK_API_KEY` in Infisical, `dev:/vercel`), never Mikka 默认 or the AI
Gateway: [local-runtime.md](local-runtime.md#which-model-local-runs-use).

Signup limits never block local work. In local test-account mode
(`localTestAccountsMode`, `scripts/test-accounts/database-target.mjs`) and
outside Vercel, the signup and verification limits default to CI's (1000 per
IP and 10000 overall each hour, instead of 5 per IP), and Better Auth's
sign-up rule rises from 3 to 100 per 10 seconds (`lib/abuse/signup.ts`). This
holds for `next dev` and `next start` alike. A limit set explicitly
(`MIKKA_SIGNUP_*_HOURLY`, `MIKKA_VERIFICATION_*_HOURLY`) still wins;
production is unchanged.

## 4. CI variables

Never set `GITHUB_ACTIONS`, `RUNNER_ENVIRONMENT`, `GITHUB_RUN_ID` or any other
CI variable to get past a test guard. A suite that runs only on a
GitHub-hosted runner is left to CI.

Database suites decide by the database, not the runner: they run wherever every
application database URL is a loopback `*_e2e` database
(`disposableDatabase` in `tests/helpers/e2e-target.mjs`) and skip or refuse
otherwise. 现状（非决定）：browser suites, the shared test-account pool
(`scripts/test-accounts/bootstrap.mjs`) and a few hosted-service suites still
require `GITHUB_ACTIONS`; those run in CI.

Local test accounts: the local mode (`MIKKA_LOCAL_TEST_ACCOUNTS=1` with a
loopback `*_e2e` database) is described in
[`test-accounts.md`](test-accounts.md#local-mode-a-developers-own-disposable-database).

## 5. Trunk-based merging

Decision: [`2026-11-01-1545-trunk-based`](design/decisions/2026-11-01-1545-trunk-based.md).

1. Every PR branches from `main` and changes one thing.
2. When its CI is green, the coordinator squash-merges it into `main`. There
   are no integration batches.
3. A change to auth, signup, privilege or credentials is reviewed before
   merging. A UI change merges only after its screenshots are reviewed.
4. A documentation conflict is resolved by whoever merges: they edit the
   documents directly.

Each of these modules has an owner. Anyone else who needs to change one asks
its owner first.

| Module | Covers | Owner |
| --- | --- | --- |
| Local development environment and fake services | `scripts/dev/bootstrap-local.sh`, local stand-ins for external services | LSV4 session |
| Local test-mode rules | Local test accounts and the guards that decide where a suite may run | PFe3 session |
| MVP acceptance | The MVP end-to-end acceptance and its record | QUe session |

## 6. Numbers

Rule ids (`R-xx`) and migration timestamps are assigned by the coordinator
when the work is dispatched, so parallel branches do not collide. A session
that needs one and has none asks the coordinator. The coordinator assigns
increasing timestamps. `scripts/check-migrations.mjs` refuses a timestamp at or below the newest one on `main`, so if they merge out
of order, whoever merges the later one renames it.

## 7. E2B templates

To test worker changes, build a `-dev` template from the branch. Do not wait
for the automatic publish that follows a merge to `main`
([`e2b-template.yml`](../.github/workflows/README.md#cloud-worker-template-release)).
Never overwrite the production template or Vercel's production environment.

## 8. Reaching a local service from outside

Use a Cloudflare tunnel when a local service must be reachable from outside.
In the cloud environment, outbound traffic goes only through a proxy on
port 443, and `cloudflared` cannot connect (it needs port 7844). Report that
as it is. Do not work around it, and never put production credentials on a
public machine.

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
