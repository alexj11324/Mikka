# Development workflow

Standing rules for how work moves from a branch to `main`. Decision:
[`2026-11-01-1440-dev-workflow-local-first`](design/decisions/2026-11-01-1440-dev-workflow-local-first.md);
ownership as Alex set it on 2026-11-03, with batch merging updated on
2026-11-05 (§ 5).
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
daemon. No browser tests run, in CI or locally
([1520](design/decisions/2026-11-01-1520-no-browser-tests-in-ci.md),
[2026-11-01-2225](design/decisions/2026-11-01-2225-api-cli-acceptance-and-backend-owner.md)): acceptance goes through the API and the CLI
(`pnpm test:local-loop`, [local-runtime.md](local-runtime.md)), and a UI change
is checked with screenshots of a local production build.

## 2. Hot reload

Debugging and pipeline runs use source, not builds:

| Part | Command |
| --- | --- |
| Server | `pnpm dev` (`next dev`, via `scripts/dev-preview.mjs`) |
| Daemon | `pnpm daemon` (`tsx` on `packages/daemon` source) |

A `pnpm dev` server peaks near 7 GB RSS while compiling the first pages
(`/[locale]/page`, settings): the root page alone is ~14k server and ~10k
client modules, and the OpenUI chat library brings every `lucide-react` icon.
Dev keeps webpack's cache in memory; the default filesystem cache added ~2.4 GB
and saved about 15 s on a restart. Cloud containers cap memory at about 14 GB,
so run one dev server at a time and no build beside it. If `next dev` exits with no
error and esbuild then prints `fatal error: all goroutines are asleep -
deadlock!`, the kernel killed `next-server` for memory; `dmesg | grep -i oom`
shows it. The esbuild message follows the kill; it is not the cause.

Use a production build (`next build` then `next start`) only for production
screenshots of a UI change. Run `next build`
directly (`pnpm exec next build`): `pnpm build` also runs lint and migrations.

When using `next build --webpack` for production screenshots, the existing
Webpack hook also keeps its cache in memory. This avoids the filesystem
cache's dependency scan and serialization buffers for the large module
graph. It trades persistent Webpack cache reuse for lower build memory;
it does not change application caching or the default Turbopack build.

Vercel builds on a Standard machine: 4 cores, 8 GB. `next build` peaks at
"Collecting page data", while Turbopack's ~5 GB is still held in the
`next-build` process. So production builds emit no source maps and stop
esbuild once the workflow bundles are built (`next.config.mjs`). To check a
change against the limit, run `next build` in an 8 GB cgroup and read
`memory.max_usage_in_bytes`.

Vercel keeps every `node_modules` and `.next/cache` between builds, up to
1.5 GB on that machine; a bigger cache is dropped and the next build starts
cold. The Expo app's packages (`react-native-skia` alone is ~840 MB) pushed it
over, so `vercel.json` installs every workspace except `@mikka/mobile`, which
the web build and typecheck do not use.

## 3. Environment

One command sets up a container: `eval "$(scripts/dev/bootstrap-local.sh)"`
([local-bootstrap.md](local-bootstrap.md)). Put it in
the cloud environment's setup script so every session starts ready. It
provides:

- **Node 24**, the same as CI. The unit tests also pass on Node 22: mock a
  module with `namedExports`/`defaultExport` (Node 22 ignores `{ exports }`)
  and use `--experimental-test-isolation` (Node 22 has no `--test-isolation`).
- **PostgreSQL 17** at `127.0.0.1:5432`, database `mikka_e2e`; migrations with
  `pnpm migrate` (it runs by itself when every target is a loopback database;
  a remote database off Vercel still needs `MIGRATE=1` and `--allow-remote`).
- **Chromium** for UI screenshots: the container's
  `/opt/pw-browsers/chromium`. Never run `playwright install`.

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
otherwise. 现状（非决定）：the shared test-account pool
(`scripts/test-accounts/bootstrap.mjs`) and a few hosted-service suites still
require `GITHUB_ACTIONS`; those run in CI. Browser suites run nowhere.

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
   `scripts/migrate.mjs`). Then the owner accepts the change in production
   against the issue's acceptance criteria, with a real account and task
   (leased test accounts, [`test-accounts.md`](test-accounts.md); no junk
   data). A simulated test is not production acceptance. The owner writes
   the evidence on the issue (time, run id, log summary; no secrets or
   personal data) and closes the issue.
6. **If production breaks,** fix forward with a new PR, or revert through a
   revert PR. Never delete deployments, revoke shared tokens, change
   production Neon settings or create paid resources without Alex.
7. **The coordinator** (a Claude Code session) writes issues, reviews and
   verifies. It merges only the PRs it leads itself; every other PR is merged
   by its own owner. Review findings go on the PR as comments for the owner.
8. A documentation conflict is resolved by whoever merges: they edit the
   documents directly.

Before any merge, the change is verified end to end in CI (for example
`Production build and browser interactions`) or with a production build
(`next build`, `next start`) in a local or Docker sandbox, against its own
isolated PostgreSQL database (`mikka_e2e`) and leased test accounts
([`test-accounts.md`](test-accounts.md)); production is never the test
environment. Pull requests and branches have no Vercel Preview: every build
runs on GitHub Actions, and only `main` deploys, to production
([decision 2026-11-05-1632](design/decisions/2026-11-05-1632-no-vercel-preview.md)).

## 6. Numbers

Rule ids (`R-xx`) and migration timestamps are assigned by the coordinator
when it writes the issue, so parallel branches do not collide. A session
that needs one and has none asks the coordinator. The coordinator assigns
increasing timestamps. `scripts/check-migrations.mjs` refuses a timestamp at or below the newest one on `main`, so if they merge out
of order, whoever merges the later one renames it.

## 7. E2B templates

Cloud machines start from new instances of E2B's official `desktop`, `claude`
and `codex` templates. The Mikka worker is added in its own directory on the
instance; the official templates are never changed or deleted
([decision 2026-11-03-1430](design/decisions/2026-11-03-1430-official-e2b-templates-unchanged.md)).

A push to `main` that changes the worker paths runs
[`e2b-official-runtime.yml`](../.github/workflows/README.md#cloud-worker-template-release).
It validates the official instances and publishes only the application
configuration. The older `e2b-template.yml` (derived templates) is paused; do
not resume it. Never change the production templates or Vercel's production
environment by hand.

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
