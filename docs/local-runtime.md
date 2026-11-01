# Local thread runtime

A device is a runner like E2B ([`design/orchestration.md`](design/orchestration.md)
§ 3). Local threads run on a connected computer with the daemon's own pinned
Claude Code or Codex, never one the person installed, in a run home of their
own. The device reports OS, architecture, free disk, Docker and the install
state of those Agents, not detected Agents. Registering the daemon or
reporting a changed harness set creates hidden execution records. Their
names include the device UUID to
respect the per-person unique name constraint; conversations show the owning
Bot or Coordinator. Removing a harness detaches its record, preserving run
history. Reinstalling it reuses that record. An unchanged heartbeat only reads
the identities; reconciliation takes the device advisory lock in a transaction.

## Dispatch and repository ownership

`dispatch_run` accepts `{ issueId, agentId, repo, note? }`. `repo` is a GitHub
`owner/repo`, a full HTTPS clone URL, an SSH URL, or an scp-style Git URL.
Shorthand expands to `https://github.com/owner/repo.git`. Local paths,
`file://`, HTTP, `git://`, and executable Git transports are rejected.

The server upserts a repository history row for `(deviceId, remoteKey(url))`.
The row retains its foreign key for claims, retries and takeover. Its
`repoPath` is a versioned logical key such as `v2/github.com/owner/repo`; `remoteUrl` is the
complete clone URL. Existing remote-matched registrations keep their IDs and
branch values but their checkout path is replaced by the logical key.

`remoteKey` uses a versioned identity. Standard GitHub HTTPS and `git` SSH
endpoints share a case-insensitive owner/repository key. Other hosts keep
transport, port, SSH user, path namespace, path case and literal `.git`
suffix distinct. SSH requires an explicit user. Legacy or mismatched keys
cannot claim or take over runs; the original clone URL of an existing record
is retained.

The daemon owns a standard clone under
`<dataDir>/repos/v2/<sha256-of-identity>` and a worktree under
`<dataDir>/worktrees/<runId>`. Clone and fetch serialize on a filesystem lock;
the lock wait and Git child process can be cancelled. A new clone uses
`--no-checkout`, fetch uses the shared safe Git configuration and disables
interactive credential prompts. All worktree creation, branch fetches,
continuation, empty-work cleanup and retention use the cache path. Symlinks
at the cache root or within its path are rejected. The daemon never fetches,
creates a branch or creates a worktree in a person's checkout.

A null database `baseBranch` and an absent assignment `baseBranch` mean the
origin default branch, read through `origin/HEAD` after fetch. Existing branch
values remain unchanged. A run taking over on another online computer keeps
its original execution ID as provenance, chooses the installed harness there,
and creates that computer's repository record automatically.

Repository policy is keyed by `(userId, remoteKey)` in `repository_settings`.
`verifyCommand`, `setup`, `networkAllow` and `push` start empty; no legacy
machine approval is carried over implicitly. Local sandbox writes include
the run's Git administration, its branch ref and shared object store.
Indirection files and repository configuration stay read-only. Daemon Git
commands pin both the worktree Git directory and common Git directory.

Protocol version 3 adds clone URLs and optional base branches. The server
returns `409 daemonUpgradeRequired` to an older local daemon before claiming
the run. Hosted computer provisioning and queueing keep their existing private
workspace contract; the shared protocol allows those assignments to omit a
remote URL.

## Isolated verification

Normal operation needs no new environment variable. `MIKKA_TEST_MODE=1`
enables `mock` and `file://` only with `NODE_ENV=test`, `CI=true`,
`VERCEL_ENV=preview`, or local test mode
([test-accounts.md](test-accounts.md#local-mode-a-developers-own-disposable-database));
do not set `CI=true` for a local server. `VERCEL_ENV=production` always
disables them. Production
deployments must not set this test switch. Vitest sets it for its disposable
Git fixtures; the Preview E2E job must set it explicitly on both server and
daemon. A production Next build alone does not enable test behavior.

The daemon integration tests use the existing `mikka daemon login --token`
path, an in-memory transport, a real daemon and temporary bare Git origins.
They check URL-only dispatch without repository registration, independent
worktrees, concurrent clone creation, cancellation, sandbox policy and
preservation of uncommitted personal files.

`tests/local-runtime.integration.ts` runs in GitHub CI's disposable
`127.0.0.1/mikka_e2e` database. It checks concurrent identity reconciliation,
the heartbeat lock-free path, remote deduplication, legacy record reuse,
nullable branches, hidden display names, and harness uninstall/reinstall
without losing run history. It refuses other environments. Migration
bootstrap and repeated application remain covered by
`tests/migrate-empty-db.test.mjs`; do not run migrations on developer or
production databases for verification.

No-origin local repositories and uncommitted checkout visibility are recorded
in `docs/design/decisions.md` as **待 Alex 确认**. Push approval and PR creation
are the following MVP deliverable; this change grants no push approval.

## Local development without GitHub (`pnpm dev:local`)

`pnpm dev:local` runs the whole loop on your own machine: Coordinator dispatch,
the push-grant check, the daemon's push, the GitHub App's pull request and the
thread showing it, with no request to api.github.com. One command, hot reload,
no `next build`:

- the local fake services from `tests/mvp/services.mjs` on `127.0.0.1:3191`
  (GitHub API, plus the substitutes in `scripts/dev-local/services.mjs`), with a bare `file://` origin for the repository
  `mikka-e2e/core-loop` (default branch `trunk`);
- `next dev` on `MIKKA_DEV_PORT` (3000) with `scripts/dev-local/preload.mjs`,
  which sends `https://api.github.com` to the fake, and the AI Gateway and
  Resend to their substitutes only when no real key for them is set;
- the daemon from source with `tsx`. Only the daemon's git sees a rewrite of
  the repository URL to the local origin.

It runs only in local test-account mode (`localTestAccountsMode`,
`scripts/test-accounts/database-target.mjs`): `MIKKA_LOCAL_TEST_ACCOUNTS=1`,
`E2E_DATABASE_URL` set, and every database URL a loopback PostgreSQL with a
user and password and a name ending in `_e2e`. Any `VERCEL` or `VERCEL_ENV`, or
`NODE_ENV=production`, refuses it. Put the variables in `.env.development.local`
(git-ignored); the script loads it.

What is fake and what is real:

| Part | dev:local |
| --- | --- |
| GitHub App, installation, push grant, pull requests | Fake (`tests/mvp/services.mjs`); a fresh App key is generated at start |
| Repository | A local bare `file://` origin seeded with `README.md` |
| GitHub identity | Synthetic: every local account is linked to GitHub account `4242`, which the fake lets write |
| Model, a workspace's own key (Settings › API 与订阅) | Real. Saving it needs `WORKSPACE_SECRETS_KEY`; without one, dev:local creates a random local key in `.cache/dev-local/workspace-secrets-key` (git-ignored, mode 0600) and reuses it, so saved keys still open after a restart |
| The DeepSeek key, added automatically | `DEEPSEEK_API_KEY` comes from the environment or the named Infisical `dev:/vercel` secret. Use the configured `INFISICAL_PROJECT_ID` (or `MIKKA_DEV_INFISICAL_PROJECT`) with an existing `INFISICAL_TOKEN` or Universal Auth identity. The managed HTTP proxy is preserved. Setup runs immediately, then reconciles every 5 seconds; existing keys are reused, new Bots and workspaces receive the Flash choice, and individual failures back off from 30 seconds to 5 minutes. The key stays in process memory and sealed application storage. Missing Flash models never fall back to another real model. Without the key, the scripted substitute below remains available for development; real-model acceptance requires the key. |
| Mikka 默认 and the Coordinator through the [AI Gateway](https://vercel.com/docs/ai-gateway) | Real with a real `AI_GATEWAY_API_KEY`; otherwise a scripted model: it echoes (`Local model: <text>`), a message `/tool <name> <json>` calls that registered tool for real, and a tool result comes back as JSON |
| Decisions (AI Gateway Decision API: triage, run outcome, push) | Real with a real `AI_GATEWAY_API_KEY`; otherwise the first choice of each question, `0.5` for a predicate |
| Card verification and credit for Mikka 默认 (Stripe) | Every local workspace gets a verification and a $1000 local allowance, checked every 5 seconds |
| Verification and password-reset mail ([Resend](https://resend.com/docs/api-reference/emails/send-email)) | Real with a real `RESEND_API_KEY`; otherwise a local outbox at `http://127.0.0.1:3191/mail` (JSON at `/mail.json`), one terminal line per mail |
| Cron (the production minute Worker, `cloudflare/suggestions-cron`) | `scripts/dev-local/cron.mjs` calls the same `/api/cron/*` endpoints on the same schedule against `next dev`, with `CRON_SECRET` or a local placeholder ([securing cron jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs)) |
| [Vercel Workflow](https://useworkflow.dev/docs/deploying/world/local-world) | The local world, as `next dev` always uses off Vercel |
| Database, auth, daemon, git clone/worktree/commit/push | Real |

### Which model local runs use

Local development and acceptance runs use DeepSeek **DS 4.1 Flash**
(`deepseek/deepseek-v4.1-flash`) through the workspace's own model API key,
never Mikka 默认 and never the AI Gateway:

- The key is `DEEPSEEK_API_KEY` in the Mikka Infisical project, environment
  `dev`, folder `/vercel`. Read it with an existing identity
  ([infisical-cloud.md](infisical-cloud.md)) into the process environment
  only; never write it to a file, a commit, a log or a report.
- `pnpm dev:local` adds it to every local account and picks DS 4.1 Flash for
  the Coordinator and the Bots (`scripts/dev-local/seed-model-keys.ts`). Outside
  dev:local, add it as a DeepSeek key in Settings › API 与订阅 and pick DS 4.1
  Flash by hand.
- Mikka 默认 (hosted, billed through the AI Gateway) is not used for local
  work, so a local run needs neither `AI_GATEWAY_API_KEY` nor a card
  verification.

First run: sign up at `http://localhost:3000/mikka`, then approve the device
with the code the script prints. Ask the Coordinator to change
`mikka-e2e/core-loop`. Running as root, set `MIKKA_DEV_DAEMON_USER` to an
unprivileged user for the daemon (bubblewrap).

The placeholders (`AI_GATEWAY_API_KEY`, `RESEND_API_KEY`, `CRON_SECRET`) are
set in the `next dev` process only. The test-account environment accepts the
exact model and mail placeholders only in local test-account mode after a
random challenge proves that the current fetch path reaches the local
transport. Real provider keys remain forbidden by that account harness.

API acceptance can call `POST http://127.0.0.1:3191/refresh` after registering
an account or creating a Bot to apply local identity, credit and model setup
immediately. Scans run serially, including requests that arrive during a prior
scan. `.cache/dev-local/runtime.json` records the application origin, fixture
repository and daemon data directory without credentials. The script compiles
the daemon API routes before starting login so their first live-policy probes
do not wait for a cold development compilation. Set
`MIKKA_DEV_SKIP_ENV_FILES=1` when the owning acceptance harness supplies the
complete environment and must not read local credential files.

Not substituted:

| Service | Local behaviour |
| --- | --- |
| PostHog | No key: every server flag reads off and kill switches read "not killed"; only the proactive profile feature (`mikka-proactive-profile`) stays hidden. The browser client's host is fixed to PostHog cloud, so a local flag service would need an application change. |
| E2B cloud computers / cloud worker | `NEXT_PUBLIC_COMPUTER_MOCK=1` for the UI. Real runs would need a local container provider in place of `lib/computer/e2b-provider.ts`. |
| Stripe checkout and webhooks | Billing pages say billing is not configured; the local credit above is what runs need. |
| BYOS subscription worker and Infisical custody | Off (`MIKKA_BYOS_ENABLED` unset): subscription model routes answer `backend_unavailable`. |
| Credential KMS (saved logins, `lib/credentials/kms.ts`) | Saving a login fails; decryption serves only E2B computers. |
| Composio, Linear, Slack, Telegram, Firecrawl, Expo push, Turnstile | Off without their keys, with no effect on the loop. |

`pnpm test:dev-local` covers the guard, the routing, the cron schedule and the
real AI SDK gateway provider against the substitutes.

`pnpm test:local-loop` runs the five MVP acceptance items through HTTP and the
real daemon CLI, using Node 24 in cloud Linux. Supply the same loopback
`E2E_DATABASE_URL`, `MIKKA_DATABASE_URL` and `DATABASE_URL`, with
`MIKKA_LOCAL_TEST_ACCOUNTS=1`. The harness creates its own uniquely named
`*_e2e` database on that local PostgreSQL server, migrates it, bootstraps the
existing account pool, registers/logs in through normal auth, approves the
daemon's device login over HTTP and starts `dev:local` on port 3110. It reads
the development DeepSeek key through the existing Infisical identity and
does not read local environment credential files or set CI variables.

The items assert the real local commit/push and synthetic GitHub PR receipt,
a normal read-only model run followed by an actual sandbox CLI push rejection
with an identical writable control, a real repository
startup failure and its thread API projection, two Bots exchanging messages,
and subscribed-task inbox persistence, ownership and removal. No browser
test or production-provider acceptance is implied. Independent items continue
after failures, and any failure produces a nonzero exit status.

Progress, per-step timeouts and 15-second heartbeats are written to
`.cache/dev-local/progress.jsonl`. Each invocation retains its environment,
source fingerprints and redacted service logs under
`.cache/dev-local/acceptance-<id>/`; a source change during the run invalidates
the overall result. Cleanup stops only its own child processes, revokes its
device credentials, releases its account lease and removes its daemon's
temporary credential files. Disposable databases and repository evidence are
retained for diagnosis.

The default also runs item 6: real Agent mailbox tools, automatic idle-Bot
notification, a reply, explicit inbox/ACK, exact-send retry and owner isolation.
Item 7 verifies notifications reaching a running daemon worker, separately
from the native-Bot exchange.

For a focused probe, use `LOCAL_LOOP_ITEMS=1` or `LOCAL_LOOP_ITEMS=4,5`; the
selected scope is recorded and does not establish a full five-item pass.
`--existing` attaches to a running local service using that run's
`MIKKA_TEST_ENVIRONMENT_FILE` and matching database targets. It acquires its
own account lease and, when needed, its own daemon credential. Items 4 and 5
run without a daemon. `scripts/dev-local/loop-item1.mjs` remains an item-1
compatibility entry.

Item 8 is the real E2B cloud leg and is selected explicitly. It runs only after
items 1–7 pass in the same invocation, or when
`LOCAL_LOOP_LOCAL_PASS_EVIDENCE` points to a `passed-items.json` with those
results and the same fixed source fingerprint. The private template ID and
worker hash come from `E2B_ACCEPTANCE_TEMPLATE` / `E2B_WORKER_SHA` or the
operator's non-secret `LOCAL_LOOP_CLOUD_TEMPLATE_FILE` metadata. Its independent
normal account lease, restricted HTTPS relay, sandbox cleanup and timing
evidence are owned by `scripts/e2b/cloud-local-acceptance.mjs`.
