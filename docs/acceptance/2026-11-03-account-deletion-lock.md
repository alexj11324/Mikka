# Account deletion lock on Neon transaction pooling

Branch: `codex/account-deletion-lock`; base `8ab87c31f6a89866bfc2def7e8c28b90ba15778b`.

## Failure and scope

The production `/api/cron/account-deletions` returned 504 during 15:54–15:55Z on 2026-11-03. Read-only diagnostics at approximately 15:59Z found one `external_pending` job and a session advisory lock with an idle holder plus an active waiter (about 26 seconds). A separate in-memory inspection of existing production configuration confirmed the main database uses the Neon pooler endpoint. No account identity, query parameters or secret values were retained here.

The three deletion entry points used session-level advisory acquisition/unlock on a checked-out application connection, without a surrounding transaction. A checked-out client does not pin a backend through Neon's transaction pooler: a later unlock can reach another backend and cannot release the first backend's lock. An idle holder alone does not prove leakage: it may also be waiting for provider I/O. The incompatible connection contract and unbounded lock wait are independently confirmed defects. Occurrence 9/10, impact 6/10: production failure observed, blocked resumptions and repeated cron timeouts.

Official source: https://neon.com/docs/connect/connection-pooling.md (`pool_mode=transaction`; session-level advisory locks unsupported).

## Change

Job serialization uses a dedicated direct session, reusing the configured database and credentials. Only the documented Neon `-pooler` hostname suffix changes; other hosts and all database/credential/TLS settings remain configured as before. Ordinary queries and independently committed deletion stages retain their existing pools and transactions. The job connection is destroyed on every success, early return and error, so no locked session is returned to an application pool. Final receipt reads finish before connection closure.

Acquisition uses `pg_try_advisory_lock`. A busy sweep counts the job as pending without updating its stage, blocked reasons or timestamp and without repeating provider cleanup. Existing production locks are not unlocked, terminated or bypassed; a previously stranded lock may still require separate operator investigation. No production data or lock was changed during this work. This timeout repair is not evidence of a material egress reduction.

## Verification

Cloud Linux, real isolated loopback PostgreSQL database `mikka_account_lock_e2e` on port 55432. No production database writes, provider calls, UI changes or browser tests.

- Red: the existing sweep waited on a competing job lock, then overwrote `provider_pending` with `deletion_step_failed` and changed its timestamp. A fixture-only statement timeout bounded the old wait.
- Green: `REQUIRE_DB=1 pnpm test:account-db`: 30 passed, zero failed/skipped. Includes a real PostgreSQL backend-switch demonstration (a second backend cannot unlock the first one's lock), mutually exclusive sessions, contention preserving the pending report without provider calls, release after errors/cancellation, and existing deletion, restoration, owner/cloud cleanup and export suites. The sweep regression selects only its own disposable job so parallel DB fixtures are untouched.
- `pnpm typecheck`, `pnpm lint`, `git diff --check`: passed.
- API/CLI acceptance: the actual cron route module mounted on an isolated Node loopback HTTP server, real database and normal cron Bearer guard. Missing authorization returned 401; an authorized request while the job lock was held returned 200/pending in 247 ms with its report unchanged. This is a route-level HTTP check, not a Next production-build check. Fixtures and lock were cleaned up.

Git-linked CI and final commit are recorded by the pull request association.
