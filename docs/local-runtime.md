# Local thread runtime

A device is a runner like E2B ([`design/orchestration.md`](design/orchestration.md)
§ 3). Local threads run on a connected computer with the daemon's own pinned
Claude Code or Codex, without replacing the person's own installed binaries.
The task uses its real worktree and ordinary process environment; local
configuration separation is only for preserving concurrent work and the
person's files. Under [1800](design/decisions/2026-11-06-1800-machine-is-the-execution-boundary.md),
the selected native CLI authentication and authorized GitHub credential are
prepared before execution, provider calls are direct, and no extra remote
permission check precedes a model or tool call. Other task Secrets follow the
separate [credential exposure boundary](design/decisions/2026-11-08-0240-credential-exposure-boundary.md).
That decision records the remaining injection migration and does not establish
runtime protection.
The device reports OS, architecture, free disk, Docker and the install
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
machine approval is carried over implicitly. The signed-in owner configures
`verifyCommand` in Plugins → GitHub → authorized repositories. Saving an empty
command disables verification, including an older cloud repository command.
URL-backed local and cloud claims use the same owner setting; existing cloud
workspace commands remain applicable when no repository settings row exists.
The daemon runs the command after submission. Without it, the result stays
unverified and publication remains a draft PR, even when GitHub CI passed.
The command editor follows the repository/project command setting used by
[Vercel Build Command](https://vercel.com/docs/builds/configure-a-build#build-command),
inside Mikka's existing authorized-repository dialog.
The Agent and verification command use the worktree's actual Git administration,
branch ref and object store. No shadow `.git` or verification clone is created
to hide that repository. Daemon Git operations retain the path and worktree
checks that protect the person's unrelated files; they do not turn read-only
task intent into another execution sandbox.

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
Git fixtures; the local acceptance harness (`pnpm test:local-loop`) sets it
on both server and daemon. A production build alone does not enable test behavior.

The daemon integration tests use the existing `mikka daemon login --token`
path, an in-memory transport, a real daemon and temporary bare Git origins.
They check URL-only dispatch without repository registration, independent
worktrees, concurrent clone creation, cancellation, task stopping and
preservation of uncommitted personal files.

`tests/local-runtime.integration.ts` runs in GitHub CI's disposable
`127.0.0.1/mikka_e2e` database. It checks concurrent identity reconciliation,
the heartbeat lock-free path, remote deduplication, legacy record reuse,
nullable branches, hidden display names, and harness uninstall/reinstall
without losing run history. It refuses other environments. Migration
bootstrap and repeated application remain covered by
`tests/migrate-empty-db.test.mjs`; do not run migrations on developer or
production databases for verification.

Repository-backed threads use independent worktrees from the remote branch.
To include local uncommitted changes, commit and push them first. The original
pending rows in `docs/design/decisions.md` are superseded by the accepted
[thread isolation decision](design/decisions/2026-11-01-2245-thread-privacy-and-local-isolation.md).

## Local development without GitHub (`pnpm dev:local`)

In cloud Linux, `pnpm dev:local` runs Coordinator dispatch, the daemon's push,
a synthetic pull request and its thread projection against local GitHub
substitutes, with hot reload. It starts these services.

- the local fake services from `tests/mvp/services.mjs` on `127.0.0.1:3191`
  (GitHub API, plus the substitutes in `scripts/dev-local/services.mjs`), with a bare `file://` origin for the repository
  `mikka-e2e/core-loop` (default branch `trunk`);
- Vite + Nitro through `apps/api/scripts/dev.mjs` on `MIKKA_DEV_PORT` (3000)
  with `scripts/dev-local/preload.mjs`,
  which sends `https://api.github.com` to the fake, and the AI Gateway and
  Resend to their substitutes only when no real key for them is set;
- the daemon from source with `tsx`. Only the daemon's git sees a rewrite of
  the repository URL to the local origin.

It runs only in local test-account mode (`localTestAccountsMode`,
`scripts/test-accounts/database-target.mjs`): `MIKKA_LOCAL_TEST_ACCOUNTS=1`,
`E2E_DATABASE_URL` set, and every database URL a loopback PostgreSQL with a
user and password and a name ending in `_e2e`. Any `VERCEL` or `VERCEL_ENV`, or
`NODE_ENV=production`, refuses it. Supply credentials through the cloud
process environment. The script also reads existing `.env.development.local`
and `.env.local` unless `MIKKA_DEV_SKIP_ENV_FILES=1`. Keep credentials out of
those files.

What is fake and what is real:

| Part | dev:local |
| --- | --- |
| GitHub App, installation, push grant, pull requests | Fake (`tests/mvp/services.mjs`); a fresh App key is generated at start |
| Repository | A local bare `file://` origin seeded with `README.md` |
| GitHub identity | Synthetic: every local account is linked to GitHub account `4242`, which the fake lets write |
| Model, a workspace's own key (Settings › 模型与订阅) | Real. Saving it needs `WORKSPACE_SECRETS_KEY`; without one, dev:local creates a random local key in `.cache/dev-local/workspace-secrets-key` (git-ignored, mode 0600) and reuses it, so saved keys still open after a restart |
| The DeepSeek key, added automatically | `DEEPSEEK_API_KEY` comes from the environment or the named Infisical `dev:/vercel` secret. Use the configured `INFISICAL_PROJECT_ID` (or `MIKKA_DEV_INFISICAL_PROJECT`) with an existing `INFISICAL_TOKEN` or Universal Auth identity. The managed HTTP proxy is preserved. Setup runs immediately, then reconciles every 5 seconds; existing keys are reused, new Bots and workspaces receive the Flash choice, and individual failures back off from 30 seconds to 5 minutes. The key stays in process memory and sealed application storage. Missing Flash models never fall back to another real model. Without the key, the scripted substitute below remains available for development. The API-key path never gates a merge or acceptance. |
| Mikka 默认 (ZeroCat, `https://zero.cat/v1`, `lib/abuse/zerocat.ts`; AI Gateway as fallback) | Not used locally: the Coordinator and Bots use DS 4.1 Flash through the DeepSeek key (below). With no `ZEROCAT_API_KEY` set, dev:local sets the placeholder `mikka-local-zerocat` and sends ZeroCat's `/v1/chat/completions` to a scripted model: it echoes (`Local model: <text>`), a message `/tool <name> <json>` calls that registered tool for real, and a tool result comes back as JSON |
| Decisions (AI Gateway Decision API: triage, run outcome, push) | Local runs set no `AI_GATEWAY_API_KEY`, so the first choice of each question, `0.5` for a predicate |
| Card verification and credit for Mikka 默认 (Stripe) | Every local workspace gets a verification and a $1000 local allowance, checked every 5 seconds |
| Verification and password-reset mail ([Resend](https://resend.com/docs/api-reference/emails/send-email)) | Real with a real `RESEND_API_KEY`; otherwise a local outbox at `http://127.0.0.1:3191/mail` (JSON at `/mail.json`), one terminal line per mail |
| Cron (the production minute Worker, `cloudflare/suggestions-cron`) | `scripts/dev-local/cron.mjs` calls the same `/api/cron/*` endpoints on the same schedule against the local API, with `CRON_SECRET` or a local placeholder ([securing cron jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs)) |
| [Vercel Workflow](https://useworkflow.dev/docs/deploying/world/local-world) | The local world configured by `apps/api/scripts/dev.mjs` |
| Database, auth, daemon, git clone/worktree/commit/push | Real |

### Which model local runs use

The existing `dev:local` seeder selects an allowed DeepSeek Flash model
through the workspace's own API key (`scripts/dev-local/seed-model-keys.ts`).
It prefers a V4.1 Flash entry and also accepts the provider's `deepseek-flash`
alias. Record the exact returned ID without asserting a version for the alias.
Live model acceptance follows the [subscription policy](acceptance.md#live-model-acceptance).
The DeepSeek/API-key leg never gates a merge or acceptance, and paid retries
must not be used to unblock it.

The existing development setup uses these settings.

- The key is `DEEPSEEK_API_KEY` in the Mikka Infisical project, environment
  `dev`, folder `/vercel`. Read it with an existing identity
  ([infisical-cloud.md](infisical-cloud.md)) into the process environment
  only; never write it to a file, a commit, a log or a report.
- `pnpm dev:local` adds it to every local account and picks DS 4.1 Flash for
  the Coordinator and the Bots (`scripts/dev-local/seed-model-keys.ts`). Outside
  dev:local, the same setup uses a DeepSeek key in Settings › 模型与订阅 with
  an allowed Flash model selected.
- Mikka 默认 (hosted, billed per call, served by ZeroCat, AI Gateway as fallback) is not
  used for local work, so a local run needs neither `ZEROCAT_API_KEY` nor a
  card verification.

The existing ZeroCat route accepts `ZEROCAT_BASE_URL=https://zero.cat/v1`
and an existing process-delivered key. Other base URLs are refused. Without
both settings, or on a failure before its first token, the route falls back to
`deepseek/deepseek-v4.1-flash` on the AI Gateway. `dev:local` substitutes that
Gateway too when no real key is present. This describes the retained runtime
route. Authorized model acceptance follows the two official subscription
paths above, and real API-key calls use only the policy's requested Flash model.

First run: sign up at `http://localhost:3000/mikka`, then approve the device
with the code the script prints. Ask the Coordinator to change
`mikka-e2e/core-loop`. Running as root, set `MIKKA_DEV_DAEMON_USER` to an
unprivileged user for the daemon (bubblewrap).

The placeholders (`AI_GATEWAY_API_KEY`, `ZEROCAT_API_KEY`, `RESEND_API_KEY`, `CRON_SECRET`) are
set in the application process only. The test-account environment accepts the
exact model and mail placeholders only in local test-account mode after a
random challenge proves that the current fetch path reaches the local
transport. Real provider keys remain forbidden by that account harness.

API acceptance can call `POST http://127.0.0.1:3191/refresh` after registering
an account or creating a Bot to apply local identity, credit and model setup
immediately. Scans run serially, including requests that arrive during a prior
scan. `.cache/dev-local/runtime.json` records the application origin, fixture
repository and daemon data directory without credentials. The script probes
the daemon API routes before starting login. Set
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
real AI SDK gateway and OpenAI-compatible (ZeroCat) providers against the
substitutes.

`pnpm test:local-loop` runs acceptance items 1–7 by default (the five MVP
items plus the two mailbox items below) through HTTP and the
real daemon CLI, using Node 24 in cloud Linux. Supply the same loopback
`E2E_DATABASE_URL`, `MIKKA_DATABASE_URL` and `DATABASE_URL`, with
`MIKKA_LOCAL_TEST_ACCOUNTS=1`. The harness creates its own uniquely named
`*_e2e` database on that local PostgreSQL server, migrates it, bootstraps the
existing account pool, registers/logs in through normal auth, approves the
daemon's device login over HTTP and starts `dev:local` on port 3110. It reads
the development DeepSeek key through the existing Infisical identity and
does not read local environment credential files or set CI variables. The
runner still requires a real DeepSeek key and asserts a Flash selection.
This is a remaining harness limitation, so this command does not establish
Claude Code or Codex subscription acceptance. An unavailable API-key leg
must not hold a merge or acceptance open.

The items cover real local commit/push with a synthetic GitHub PR receipt,
a normal read-only model task, repository startup failure and its thread API
projection, two Bots exchanging messages, and subscribed-task inbox persistence,
ownership and removal. The older item-2 sandbox push-rejection contract is
superseded by [1800](design/decisions/2026-11-06-1800-machine-is-the-execution-boundary.md):
read-only is task intent and does not remove the Agent's real GitHub credential.
A result from that old rejection case is not acceptance of the direct-credential
runtime. No browser
test or production-provider acceptance is implied. Independent items continue
after failures, and any failure produces a nonzero exit status.

Progress, per-step timeouts and 15-second heartbeats are written to
`.cache/dev-local/progress.jsonl`. Each invocation retains its environment,
source fingerprints and redacted service logs under
`.cache/dev-local/acceptance-<id>/`. A change to a fingerprinted file during the
run invalidates the overall result. The driver's fingerprint list omits
`apps/`, which contains the Vite frontend and Nitro API. Keep the entire
checkout fixed and record those sources separately when using this evidence.
Cleanup stops only its own child processes, revokes its
device credentials, releases its account lease and removes its daemon's
temporary credential files. Disposable databases and repository evidence are
retained for diagnosis.

Item 6: real Agent mailbox tools, automatic idle-Bot
notification, a reply, explicit inbox/ACK, exact-send retry and owner isolation.
Item 7 verifies notifications reaching a running daemon worker, separately
from the native-Bot exchange.

For a focused probe, use `LOCAL_LOOP_ITEMS=1` or `LOCAL_LOOP_ITEMS=4,5`; the
selected scope is recorded and does not establish a full default pass.
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
normal account lease, test-service connectivity, owned-VM cleanup and timing
evidence are owned by `scripts/e2b/cloud-local-acceptance.mjs`.

Item 9 is an opt-in offline Factory handoff between two real local daemons.
Run `LOCAL_LOOP_ITEMS=9 LOCAL_LOOP_EXPECTED_SOURCE_SHA=<reviewed-40-character-commit>
pnpm test:local-loop` on the fixed Linux checkout, with the same normal local
account-pool/database/Flash environment described above. The source pin must
match HEAD. This item cannot attach with `--existing`: it must own both daemon
processes and its fresh disposable database. It adds a 15-minute item budget;
allow that time in addition to any other selected items and initial setup.

The runner approves two distinct device IDs through the normal owner APIs.
The dedicated ordinary owner must have no E2B key, so existing cloud-first
recovery cannot legitimately replace the intended B target. Once A has run
the real Flash workload and saved a repository checkpoint, the runner checks
Linux process ancestry and suspends A's isolated process groups, including
detached native children. The application and existing local minute cron continue.
The normal 90-second lease expires without edits to server state or thresholds;
B must really claim the server-created retry of the same Task and request epoch.
The test reads the structured Handoff and frozen payer/owner identity, resumes
A to exercise lease fencing, checks exact artifact bytes/hash and one PR, and
accepts the independently reviewed/verified candidate through the human API.
It observes one further minute schedule for duplicate retries or publications.

`item9-handoff.json` retains phase, Task/run/epoch/device identifiers, checkpoint,
Handoff digest, artifact hash, publication count and failure status. SQL reads
only evidence in that disposable database; dispatch and acceptance remain
authenticated API operations. Timeout/interruption restores paused processes
before ordinary cleanup. This case proves offline local-device handoff only:
it does not establish the separate 45-minute online-stall watchdog, official
subscription behavior, or production-provider acceptance. The process and
receipt guard tests are included in `pnpm test:dev-local` and make no model calls.

Item 10 isolates the server's real online-stall watchdog. Select
`LOCAL_LOOP_ITEMS=10` or `LOCAL_LOOP_ITEMS=9,10` with the same immutable
`LOCAL_LOOP_EXPECTED_SOURCE_SHA`; it also requires the owned fresh Linux stack.
The selected item configures these dedicated local daemons using the existing
formal CLI option `--stall-minutes 60`. The normal daemon default is 10 minutes,
which would stop a silent executor before the server's unchanged 45-minute
execute window. Evidence states this isolation explicitly. When 9 and 10 run
together, they share the already approved second daemon; item 10 starts only
after item 9 passes. The 60-minute daemon setting is recorded for both cases.

After the real Flash run creates a file and uploads a checkpoint, item 10 binds
its observed native session to the unique direct child of the real daemon RPC
PID whose cwd matches that worktree's inode. It verifies ancestry and PID start
time, then pauses that native tree by individual PID. Claude's SDK transport
shares its parent's process group, so the fault injector never signals that
group or relies on the different legacy `spawnCli` PID-file path. A's daemon, real heartbeat/lease and
the independent minute cron keep running. Once per minute, evidence records
that no tool result or new checkpoint has reset persisted progress. It does not
alter database times, production defaults or the server sweep schedule. At the
real watchdog stop request, it waits for pending TERM/INT on the original PID
(local cancellation has reached the CLI), or actual native exit plus host
acknowledgement, before resuming any native processes. The normal revoked-lease
stop/ack must report failure with `device_lost`, never a resumed success. It
then observes one automatic admission on authorized B.

This case deliberately preserves the original checkpoint. After 45 minutes it
is outside the existing 30-minute recovery window, so the expected result is
`bounded_checkpoint_block`: B refuses it before native/model execution. The
test requires the same Task/epoch, the current Handoff, the stale-checkpoint
summary through the ordinary owner Thread API, one blocked-run notification
event/inbox delivery, and no publication or repeated admission across two
further minute schedules. It does not call that outcome successful recovery.
`item10-watchdog.json` retains timing, heartbeat/lease samples, Handoff identity,
retry and notification counts, the public blocker and failure status. Timeout
or interruption separately requests the owner's normal stop before restoration;
if cancellation cannot be confirmed, it terminates only the captured native PIDs
whose start times still match. Cleanup is never counted as watchdog evidence.
The item budget is 60 minutes; allow setup and selected item 9 in addition.
This is not a default-daemon latency measurement, a before/after benchmark or
cloud-device acceptance. Its offline guards make no model calls.
