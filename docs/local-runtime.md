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
enables `mock` and `file://` only with `NODE_ENV=test`, `CI=true`, or
`VERCEL_ENV=preview`. `VERCEL_ENV=production` always disables them. Production
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
  (GitHub API, Decisions), with a bare `file://` origin for the repository
  `mikka-e2e/core-loop` (default branch `trunk`);
- `next dev` on `MIKKA_DEV_PORT` (3000) with `scripts/dev-local/preload.mjs`,
  which sends only `https://api.github.com` to the fake (and the Decisions
  endpoint when no real `AI_GATEWAY_API_KEY` is set);
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
| Decisions | Real with a real `AI_GATEWAY_API_KEY`; otherwise the fake |
| Model | Real: the workspace's own API key (Settings › API 与订阅) |
| Database, auth, daemon, git clone/worktree/commit/push | Real |

### Which model local runs use

Local development and acceptance runs use DeepSeek **DS 4.1 Flash**
(`deepseek/deepseek-v4.1-flash`) through the workspace's own model API key,
never Mikka 默认 and never the AI Gateway:

- The key is `DEEPSEEK_API_KEY` in the Mikka Infisical project, environment
  `dev`, folder `/vercel`. Read it with an existing identity
  ([infisical-cloud.md](infisical-cloud.md)) into the process environment
  only; never write it to a file, a commit, a log or a report.
- Add it as a DeepSeek key in Settings › API 与订阅, then pick DS 4.1 Flash for
  the Coordinator and the Bot.
- Mikka 默认 (hosted, billed through the AI Gateway) is not used for local
  work, so a local run needs neither `AI_GATEWAY_API_KEY` nor a card
  verification.

First run: sign up at `http://localhost:3000/mikka`, then approve the device
with the code the script prints. Ask the Coordinator to change
`mikka-e2e/core-loop`. Running as root, set `MIKKA_DEV_DAEMON_USER` to an
unprivileged user for the daemon (bubblewrap).
