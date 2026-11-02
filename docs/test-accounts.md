# Reusable acceptance accounts

Issue #349 adds a runner-owned account pool for isolated acceptance. It uses the
application's normal Better Auth registration and sign-in routes, ordinary user
identities, and the PostgreSQL instance already owned by the test job. It does
not create product roles or a separate authentication system.

## Supported environment and side effects

The adapter supports one disposable loopback PostgreSQL database, in CI or in
local test-account mode (below). Application, workspace and pool metadata must
all address that exact database. A multi-database or deployed Preview adapter
needs independent registration and approval; the current adapter rejects it.
A production deployment is not supported.

The owning harness creates the disposable resource and initializes the normal
application schema. Before any users exist, it installs a random environment
marker in `mikka_test_accounts.environment` and writes a private descriptor.
The descriptor binds:

- A stable environment ID and a random database instance ID.
- Exact origin, `/mikka` base path and 40-character deployment commit SHA.
- PostgreSQL host, port, database, schema and login role.
- Explicit provisioning/reset permissions and disabled external email delivery.

`E2E_DATABASE_URL`, `MIKKA_DATABASE_URL` and `DATABASE_URL` must be explicitly
present and identical. An unexpected legacy fallback is rejected.
`BETTER_AUTH_URL`, optional `E2E_BASE_URL` and `MIKKA_TEST_DEPLOYMENT_SHA` must
match the descriptor. Missing configuration never falls back to a developer or
production database. `RESEND_API_KEY`, configured external model/service keys,
native coordinator autostart and deployed Vercel environments are rejected by this
adapter. An origin label, `_e2e` suffix, loopback address,
`NODE_ENV` or arbitrary enable flag alone does not authorize a write.

Every pool transaction checks actual `current_database()`, `current_schema()`,
login role and the registered instance binding. Normal `prepare`, `inspect` and
account commands cannot install the marker that authorizes their own access.
The bootstrap rejects pre-existing users, an unrelated metadata namespace, a
mismatched descriptor or a lost ownership file instead of adopting the database.

The test runner also proves the actual server binding before authentication.
`GET /mikka/api/test-environment` answers a fresh random HMAC challenge using a
key stored only in the registered database. The response binds the environment,
instance, exact origin, database fingerprint and compiled build SHA. The runner
verifies the proof using the same database connection. The endpoint performs
only reads, issues no cookie and cannot register, log in, reset or mint a session.
It returns 404 when the environment, origin, marker or build does not match.

## Bootstrap

The database CI job and local runs bootstrap the disposable PostgreSQL
database after schema setup and before tests create users:

```sh
node scripts/test-accounts/bootstrap.mjs --output .cache/e2e/environment.json
```

They set `MIKKA_TEST_ENVIRONMENT_FILE` to that file and
`MIKKA_TEST_DEPLOYMENT_SHA` to the checked-out commit. The bootstrap validates the
checkout against the SHA, the explicit workflow-owned service target, and the
actual database before its first DDL. The descriptor is written mode 0600; its
parent directory is mode 0700 when created. The directory is ignored by Git and
excluded from public CI artifacts.

A cloud harness that starts its own PostgreSQL process uses the exported
`bootstrapEnvironment` function. It must supply an `authorizeDatabase` callback
that verifies the created resource's data directory/process/container identity
against the exact connection. It must not impersonate GitHub Actions by setting
CI flags. Ordinary shared or production databases have no bootstrap path here.

### Local mode (a developer's own disposable database)

`MIKKA_LOCAL_TEST_ACCOUNTS=1 node scripts/test-accounts/bootstrap.mjs --output <file>`
is that path for a PostgreSQL 17 you started yourself on this machine (the
version CI uses). It reads no
CI variable and sets none. Before connecting it refuses any database that is
not on `127.0.0.1`, `localhost` or `[::1]` or whose name does not end in `_e2e`;
after that it applies the CI checks unchanged (a database with no users and no
marker, the checked-out SHA equal to `MIKKA_TEST_DEPLOYMENT_SHA`, no mail or
external service keys). Start from an empty database: migrate, run
`pnpm test:e2e:setup`, then bootstrap. Keep the PostgreSQL data directory
outside the session scratchpad, whose permissions can change under a running
server.

The rule is one function, `localTestAccountsMode` in
`packages/protocol/src/local-test-mode.ts`: `MIKKA_LOCAL_TEST_ACCOUNTS=1`, no
`VERCEL` or `VERCEL_ENV`, `E2E_DATABASE_URL` set, and every configured database
URL a loopback `*_e2e` database. The bootstrap, auth origins
(`lib/auth-config.ts`), signup limits (`lib/abuse/signup.ts`), the daemon's
`MIKKA_TEST_MODE` (`daemonTestMode`) and the MVP acceptance all use it. MVP
acceptance runs through the API and the CLI: `pnpm test:local-loop`
([local-runtime.md](local-runtime.md)). No browser tests run, locally or in CI
([decision](design/decisions/2026-11-01-2225-api-cli-acceptance-and-backend-owner.md)); the `pnpm test:e2e:mvp` specs
are not an acceptance entry point.

Do not set `CI` for a local server.

- Every acceptance run registers new accounts. In local test-account mode the sign-up
  and verification limits default to 1000 per address and 10000 overall each
  hour, and Better Auth's sign-up rule to 100 per ten seconds
  (`lib/abuse/signup.ts`); outside it they stay at five sign-ups per address
  an hour and Better Auth's three per ten seconds. An explicitly set
  `MIKKA_SIGNUP_*_HOURLY` or `MIKKA_VERIFICATION_*_HOURLY` still wins. Run one
  acceptance process at a time and do not register by hand during a run.

The environment binding is immutable for its lifetime. A new SHA or origin
requires a new disposable environment and descriptor; changing an alias while
an acceptance run is active cannot redirect its sessions.

## Shared module and CLI

`acquireTestAccounts` in `scripts/test-accounts/session.mjs` is the authenticated
entry point used by HTTP/API acceptance. It returns owner/peer request
clients and private storage-state references. `withTestAccounts` adds automatic
release around an awaited callback.

The thin CLI manages metadata reservations and reports state. It does not print
credentials or authenticate a person merely to inspect the pool:

```sh
node scripts/test-accounts/cli.mjs prepare --pairs 2
node scripts/test-accounts/cli.mjs inspect
node scripts/test-accounts/cli.mjs acquire --run acceptance-1 --worker worker-1 --request attempt-1 --lease-file .cache/e2e/lease.json
node scripts/test-accounts/cli.mjs renew --lease-file .cache/e2e/lease.json
node scripts/test-accounts/cli.mjs release --lease-file .cache/e2e/lease.json --outcome clean
node scripts/test-accounts/cli.mjs cleanup-plan --run acceptance-1
node scripts/test-accounts/cli.mjs audit-evidence --evidence test-results
```

All commands read `MIKKA_TEST_ENVIRONMENT_FILE`. `inspect`, `cleanup-plan` and
`--dry-run` never initialize pool tables, register users, log in, refresh a
session, send email, revoke sessions or delete resources. `prepare` initializes
only pool metadata after verifying the existing registered database marker.
A CLI `acquire` reserves a lease; actual authentication belongs to the runner
module and its heartbeat lifecycle.

## Pool and session lifecycle

The shared entry point allocates an owner/peer pair to a run, worker and request
ID. They are two ordinary users with separate namespaces. PostgreSQL coordinates
allocation across real processes connected to the same database. A process-local
map is not the authority. Different jobs with different databases have separate
pools; multi-host workers require access to the same registered database and an
authorized private session-storage adapter before sharing accounts.

Acquisition records a lease ID, holder, generation and database-clock expiry.
A repeated request resolves to the same lease rather than consuming a second
pair. Renewal, release and mutation require the current holder and generation.
A stale worker cannot release or reset a newer holder's account. Exhaustion is a
bounded blocked result, not an unlimited retry or a fallback to a personal user.

A lease expiry is evidence that renewal stopped, not that the previous worker
stopped. Expired leases enter quarantine. They cannot become available merely
because time elapsed. On heartbeat failure, the session runner stops issuing
requests and tells browser fixtures to close their contexts. A failed context
close, dirty data, invalid session or incomplete provisioning keeps the pair
quarantined.

A normal release closes the consumer contexts, revokes the owned issued sessions
and verifies removal of that lease generation's private state files before
returning a clean pair. A removal failure quarantines the pair and reports a
fixed error code; it never reports an available account with leftover state.
Reusing the user
on a later run uses the normal sign-in endpoint and verifies the returned
identity. Credentials and cookie material remain inside the test runner's private
files/memory; public CLI output contains non-sensitive IDs and blocked codes.
Session files are removed on release. Reusable credentials and the private
secret-scanning material remain only for the owning disposable environment's
lifetime, then leave with that resource. Never upload the `.cache/e2e` directory
or its private account/session files. CI may upload only its explicitly allowlisted
summaries and logs: `.cache/e2e/http-acceptance-summary.json`,
and `.cache/e2e/account-http-evidence.json`, after the evidence scan passes.

Account cleanliness includes ordinary owned rows and their descendants through
actual PostgreSQL foreign keys, plus reviewed logical links for legacy E2E
schemas that omit FK constraints. It includes indirect data such as run chunks,
artifact versions and conversation messages. Membership alone does not select
another person's workspace. The walk is bounded and fails closed if ownership
cannot be established. This does not authorize use of arbitrary untracked global
key-value state; tests that mutate such state need an explicit ownership adapter.

Account release does not delete a user. Resource manifests and `cleanup-plan`
report the exact resources attributable to a run. They protect active leases and
resources owned by other runs, including accounts now leased by a later run.
Non-session fixture IDs must be reserved before creation; existing rows cannot be
relabeled as newly created. Incomplete provisioning is listed by a masked identity
hash and any verified user ID, while the pair stays quarantined. Planning is read-only; it does not revoke a
session, reset data, refresh authentication or perform deletion. Removal of a
whole disposable test resource is the owning harness's normal, separately
verified lifecycle action.

## Browser and HTTP integration

History: no browser tests run any more
([decision](design/decisions/2026-11-01-2225-api-cli-acceptance-and-backend-owner.md)); the browser adapter below is
kept for reference. HTTP acceptance is current.

The settings-surface browser test acquired its two accounts through
`tests/e2e/test-account-fixtures.ts`. Cookie storage is bound to an environment,
account and origin. The first adapter uses Chromium: `context.newPage()` waits
for its CDP request gate before returning. Initial routing and that gate validate
the complete origin before each request, including every redirect hop, without
buffering SSE bodies or replacing the browser cookie jar. An initial popup whose
Page is not yet available is rejected before contacting any server; popup flows
need a separate target-initialization adapter and are not supported in this phase.
Protocol interception failures or unexpected protection-session detachment close
the context and fail acceptance; a blocked
counter alone is not evidence that a request was stopped.
Browser cookies themselves do not distinguish ports. WebSockets are not supported
by this adapter and are closed locally without opening an upstream connection.
Browser traffic stops
when a lease is lost. Traces, HAR, automatic screenshots and video are disabled
for leased sessions because they can capture credentials. Tests attach only
explicitly masked screenshots and non-sensitive lease metadata.

Authentication tests retain real registration, sign-in, sign-out, expiry,
revocation and ownership checks. A storage-state fixture is not evidence that
those authentication behaviors passed.

The `scripts/test-accounts/run-http.mjs` runner owns an exact-build Next child,
proves its deployment identity, runs the HTTP suite and stops its process group
on success, failure, cancellation or timeout. It never reuses an existing server.
It exposes named TAP results and counts, while discarding raw server output and
arbitrary test diagnostics that could serialize credentials. HTTP acceptance
uses the normal Next server and PostgreSQL and exercises unauthenticated, owner
and peer access to existing product routes without invoking a real model or external provider.
Attestation and authenticated HTTP responses enforce their decoded byte budgets
while reading (4 KiB and 8 MiB respectively), cancelling an oversized stream
before allocating an unbounded response. The HTTP client remains non-streaming.

## Evidence and limits

Record the exact commit, environment ID, origin, database logical target,
timestamp, run/lease IDs, non-sensitive account IDs and expected/actual results.
Do not place credentials, cookies, tokens, raw authentication responses or
unfiltered driver errors in logs, PRs, screenshots, traces or public artifacts.
Secret scans must include the generated logs and exported browser evidence.
CI runs no browser tests (decision 2026-11-01-1520). The lease session scans
the evidence it records (`scripts/test-accounts/session.mjs` with
`evidence-content.mjs`); the scanner also decodes the ZIP payload embedded inside Playwright HTML reports,
with bounded entry count, depth and decompressed size. It rejects malformed,
encrypted, unsupported and raw nested archives. The regular registration fixture
records its generated passwords and cookies in the same protected scanner store.
Scanning finds known credential encodings in raw files and decoded report entries; it cannot establish what
is visually readable in a raster screenshot. Screenshots must also be explicitly
masked and visually reviewed. Traces, HAR and recordings remain forbidden for
leased sessions rather than being declared safe by a byte scan.

The real PostgreSQL suite uses independent Node processes to test exclusive
allocation, concurrent disjoint pairs, idempotent retries, fencing, crash/expiry
quarantine, exhaustion, partial provisioning and read-only inspection. The actual
HTTP and browser checks establish behavior only for the recorded isolated
environment. They do not establish production or provider-OAuth acceptance.
