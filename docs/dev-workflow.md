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
daemon.

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
  `MIGRATE=1 pnpm migrate` (without `MIGRATE=1` the script skips everywhere
  but Vercel Production).
- **bubblewrap, socat and ripgrep** for the daemon's sandbox and tools.
- **Playwright** on the container's Chromium: set
  `executablePath: '/opt/pw-browsers/chromium'`. Never run
  `playwright install`.

Signup limits never block local work: outside production and Vercel, with
`MIKKA_LOCAL_TEST_ACCOUNTS=1` and a loopback `*_e2e` app database, the signup
and verification limits default to CI's (1000 per IP, 10000 overall, each hour)
instead of 5 per IP; an explicitly set `MIKKA_SIGNUP_*_HOURLY` or
`MIKKA_VERIFICATION_*_HOURLY` still wins (`lib/abuse/signup.ts`). `next start`
runs with `NODE_ENV=production`, so a production build keeps the production
defaults unless those variables are set, as the bootstrap's export line does.

## 4. CI variables

Never set `GITHUB_ACTIONS`, `RUNNER_ENVIRONMENT`, `GITHUB_RUN_ID` or any other
CI variable to get past a test guard. A suite that runs only on a
GitHub-hosted runner is left to CI.

现状（非决定）：many database and browser suites, and the shared test-account
pool (`scripts/test-accounts/bootstrap.mjs`), refuse to run unless
`GITHUB_ACTIONS` and related variables are set, and several hard-code port
5432. Until those guards learn the local environment, those suites run in CI.

Local test accounts: the local mode (`MIKKA_LOCAL_TEST_ACCOUNTS=1` with a
loopback `*_e2e` database) is described in
[`test-accounts.md`](test-accounts.md#local-mode-a-developers-own-disposable-database).

## 5. Merge batches

Pull requests waiting to merge go in batches of five:

1. The coordinator makes an integration branch `integration/<date>-<n>` (for
   example `integration/2026-11-01-1`) from `main`.
2. Each PR is merged into it with a merge commit. Never squash, and never
   rebase someone else's branch.
3. For stacked PRs, take only the top one; it carries the ones below.
4. A UI change goes in only after its screenshots are reviewed.
5. The coordinator squash-merges the integration PR into `main`, then closes
   the original PRs with a link to it.

A documentation conflict is resolved by the integration session, which merges
the documents' content itself; it is not sent back to the authors and not
deferred to another batch.

Several small fixes go to an integration branch together and are pushed once,
instead of a full CI round for each fix.

`integration/` replaces the older `integrate/` prefix; CI accepts both
(`browser-tests.yml`, `subagents.yml`).

## 6. Numbers

Rule ids (`R-xx`) and migration timestamps are assigned by the coordinator
when the work is dispatched, so parallel branches do not collide. A session
that needs one and has none asks the coordinator. The coordinator assigns
increasing timestamps. `scripts/check-migrations.mjs` refuses a timestamp at or below the newest one on `main`, so if they merge out
of order, the integration session renames them.

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

## 12. Local substitutes for cloud services

`pnpm dev` in local test-account mode (`MIKKA_LOCAL_TEST_ACCOUNTS=1` with
every application database a loopback `*_e2e` database, the switch in
`scripts/test-accounts/database-target.mjs`) also starts loopback substitutes
for the cloud services development mode needs, on `127.0.0.1:3192`
(`MIKKA_LOCAL_SERVICES_PORT`). `MIKKA_LOCAL_SERVICES=0` turns them off. They
never start under `NODE_ENV=production`, `VERCEL` or `VERCEL_ENV`, and a
production build contains none of them.

```sh
eval "$(scripts/dev/bootstrap-local.sh)"
export MIKKA_LOCAL_TEST_ACCOUNTS=1 BETTER_AUTH_SECRET=<any local value>
pnpm dev
```

The Next process gets `scripts/dev/local-preload.mjs` (through
`NODE_OPTIONS=--import`), which sends these requests to the substitutes and
leaves every other request alone; the application code is unchanged.

| Cloud service | Local substitute |
| --- | --- |
| [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) model (`ai-gateway.vercel.sh/v*/ai/language-model`, Mikka 默认 and the Coordinator) | A scripted model. It echoes (`Local model: <text>`); a message `/tool <name> <json>` calls that registered tool for real; a tool result comes back as JSON. Streaming and non-streaming. |
| AI Gateway Decision API (`/v1/decisions`, triage, run outcome) | The first choice of each choice question, `0.5` for a predicate. |
| Stripe card verification (the hosted credit gate) | Every local workspace gets a `hosted_verifications` row and a $1000 `hosted_allowances` row, checked every 2 seconds. |
| [Resend](https://resend.com/docs/api-reference/emails/send-email) (verification and password-reset mail) | A local outbox at `http://127.0.0.1:3192/mail` (JSON at `/mail.json`); the terminal prints one line per mail. |

The Next process alone gets placeholder values for `AI_GATEWAY_API_KEY` and
`RESEND_API_KEY`, which only the substitutes accept; the shell keeps none, so
the test-account harness, which refuses provider keys, is unaffected. Any
real key set in the shell is replaced in that process and never sent.

`scripts/dev/bootstrap-local.sh` prints database URLs with a placeholder
password (`e2e:local@`), because local mode requires one; trust auth ignores
it.

`pnpm test:local-services` covers the switch, the routing and the real AI SDK
gateway provider against the substitutes.
