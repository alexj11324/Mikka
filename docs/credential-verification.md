# Credential backend verification

**Acceptance status: NOT COMPLETE (#180 / MIK79).** No deployment, real target-account
login, model-driven harness turn, frontend screenshot or production isolation acceptance
is claimed. Frontend implementation belongs to the separate Claude workflow.

## Candidate history

The initial backend and system integration were frozen at `e7ab80c593f6ae8b3ad345f8873c56f2b67b1679`
on base `5a0e1c411f487fee433c48414f7130d0d58dad92`. That candidate passed 18
HTTP/Postgres/Chromium tests and an actual Next → daemon bridge → harness MCP child
transport test using synthetic vault/site fixtures. This was local system evidence,
not complete product acceptance. The independently reviewed fixes covered pool reuse,
policy drift, cleanup retry, cancellation races, cookie redaction and bridge recovery.
These were scoped engineering reviews, not a sealed security scanner run.

An explicitly authorized, separate real Infisical staging check created four synthetic
records, compared values inside the trusted process, deleted each record and confirmed
exact-name GET 404. Pending record cleanup was zero. This proves provider CRUD only;
it is not proof of real account login or a combined deployed flow. It is not repeated
by normal tests. Raw logs, record identifiers and operator manifests remain private.

## Current-main integration

The resumed candidate incorporates main `8f8484f` without textual merge conflicts.
Runtime SQL and fixtures now use the renamed `mikka_team_issues` / `mikka_teams` tables.
Main's existing heartbeat renewal and lost-run recovery are preserved; this backend
adds no separate renewal protocol. Credential bindings remain tied to the original
owner, task, run, execution session and current lease.

Fresh integration checks: actual Next/worker MCP/harness-child/browser flow passed;
root and daemon typechecks, focused lint, 35-file migration policy and 11 migration
policy tests passed. The 18-case HTTP/SQL/Chromium suite initially reported a normal
finish cleanup quarantine while running alongside Next. Its serial rerun passed 18/18;
the initial failure is retained and its underlying close/delete error was not captured.
Review identified overlapping TTL/cancel/finish destruction as a separate concurrency
risk. Destruction now joins one attempt per session, retains the five-second deadline,
and permits cleanup retry after failure; the suite includes concurrent finish signals.
Own unshipped migrations were renamed after current main's newest migration. Final
post-change results are recorded in the draft PR; this summary does not erase failures.

## Reproduction

Use a dedicated cloud Linux environment, Chromium and a disposable loopback Postgres
cluster. The scripts create uniquely named fixture databases and remove only their
own databases. Never point them at application databases.

```sh
CREDENTIAL_TEST_ADMIN_DATABASE_URL=postgresql://fixture@127.0.0.1:5432/postgres \
  node --import tsx scripts/test-credential-backend.mjs
CREDENTIAL_TEST_ADMIN_DATABASE_URL=postgresql://fixture@127.0.0.1:5432/postgres \
  node --import tsx scripts/accept-credential-system.mjs
node --import tsx --test lib/credentials/daemon-bridge.test.ts
```

The system driver runs actual Next routes, Better Auth, device registration/claim,
worker MCP, the actual RunContext MCP child, commands delivery and owned Chromium.
Its vault/site are synthetic. PASS is emitted only after process/database cleanup and
output-confidentiality checks. Use normal owned cache mounts when running in a container;
do not disable SWC ownership checks or expand sandbox privileges to make tests pass.

## Remaining gates

- Actual model-driven harness turn and SRT per-run isolation. The prior ordinary
  container rejected user-namespace creation with `Operation not permitted`; no
  privileged retry or security bypass was performed.
- Authorized real target-account login and the same-version Claude secure form,
  including genuine UI evidence. Do not send credentials through chat/tool arguments.
- Actual ingress/APM/telemetry exclusions, a dedicated trusted browser runner and
  supervisor reclamation after host crash. Opt-in configuration is not isolation proof.
- Same-version integration with BYOS: preserve its cron and dependency additions and
  reconcile daemon hooks. Existing shared CUA remains unavailable for secret filling.

The API contract is in [credential-backend.md](credential-backend.md). Public delivery
contains source, synthetic tests and technical summaries only. No issue should be closed
on the strength of local tests or a draft PR.
