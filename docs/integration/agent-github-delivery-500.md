# Agent-owned GitHub delivery (#500)

Coding agents own commit, push, PR creation and CI repair. CI webhooks do not
resume an ended agent. The agent stays in its existing run, waits with
`gh pr checks --watch`, reads failures and repeats until its final commit passes.

## Credentials

`POST /api/runs/github-token` accepts the existing worker bearer token. The
request cannot select a repository. The server derives the accepted repository,
checks the owner/device/task/lease, STOP, repository admission, current policy,
workspace access and linked GitHub identity, and refuses planning, acceptance,
benchmark and non-execution Factory runs. The existing GitHub App verifies the
person's write access before minting an installation token for one repository.
The token permits contents/PR writes and checks/actions reads. The App key is
never returned. Responses are `no-store`.

Authorization is checked again after issuance; if it changed, the freshly minted
token is revoked instead of returned. GitHub's already-issued installation tokens
can otherwise remain usable until their one-hour expiry. Stopping a run prevents
new exchanges; it is not an immediate revocation claim for an already-issued token.

Git and gh use run-local private files outside the checkout. Tokens are cached
for at most fifty minutes. Each long native gh watch process is restarted after
forty minutes with a token having at least forty-one minutes left. This preserves
native gh output, flags and exit codes, and supports gh 2.46 without requiring
`pr checks --json`. No global git/gh login or developer credential is copied.

## Completion

The task PR body ends with its `mikka-issue` marker. Completion verifies the
already-committed tree, pushed task branch, PR binding and the exact commit's CI
rollup. The daemon does not create another commit or push after the CI result.
Read-only receipt work uses daemon-private configuration, not executable files
or configuration from the agent-writable run directory. Normal local sandbox
and hosted native execution retain their existing filesystem, network, lease
and subscription boundaries.

## Evidence boundaries

Focused automated tests cover provider contracts, actual authorization logic
with explicit DB/identity IO substitutes, expiry/STOP races, credential cache
renewal, native watch restarts, real isolated Git repositories, and receipt
validation. A test GitHub response or CLI fixture does not prove live GitHub App
installation permissions, a real PR's CI failure/repair, or a native model run.
Record those live results separately before closing #500; existing machine gh
authentication is not a substitute for the worker-token exchange.

## This implementation's local verification

- Root TypeScript, full oxlint and UI/interaction policies passed.
- Provider contract/authorizer/exchange tests: 45 passed; helper tests: 6 passed.
- Actual isolated PostgreSQL authorizer/exchange runner: 11 passed, zero skips,
  against `127.0.0.1:55432/mikka_500_e2e`; all fixture run tokens were revoked.
- Runtime/context/Git/progress selection: 36 passed, 7 existing conditional skips;
  all six new cases passed. Real Docker Codex GitHub probe passed. The Claude
  Docker case hit its unchanged 45-second case deadline during a second Docker
  container creation on the managed vfs daemon; this is not recorded as a pass.
- The self-contained daemon package built with its standalone helper included.
- A read-only live-provider preflight authenticated the configured Infisical
  workload identity, but the configured project's environment `/vercel` lookup
  for `GITHUB_APP_PRIVATE_KEY` returned HTTP 404. No live installation token,
  provider write, real PR CI repair or provider acceptance is claimed.

The real database runner is `scripts/acceptance/run-github-token-500.mts`.
It requires matching `E2E_DATABASE_URL`, `MIKKA_DATABASE_URL`, `DATABASE_URL`
pointing at an isolated loopback `_e2e` database and runs with:

```sh
REQUIRE_DB=1 NODE_ENV=test node --import ./tests/support/server-only.mjs \
  --import tsx --test scripts/acceptance/run-github-token-500.mts
```
