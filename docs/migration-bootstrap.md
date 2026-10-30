# Migration bootstrap

`MIGRATE=1 pnpm migrate` applies the tracked SQL files to the configured application (`MIKKA_DATABASE_URL`) and workspace (`DATABASE_URL`) databases. Do not run it against a developer or production database as a test. `pnpm build` runs `node scripts/migrate.mjs` last, after `next build` succeeds; the script only applies files in Vercel Production (or with `MIGRATE=1`), so every production deploy migrates itself and Preview/CI builds skip it. A failed migration fails the deploy and the previous deployment keeps serving, so migrations must stay backward-compatible with the code that is live.

## The pre-history baseline

The numbered migrations originally assumed that issue/editor/agent-session tables and Better Auth's core tables already existed. `20261023221259_application_baseline.sql` supplies those prerequisites on an empty database. Its timestamp follows the migration naming rule; `scripts/migration-order.mjs` explicitly puts this one named file before `0001`. Every other migration retains its filename and relative lexical ordering, including the frozen historical duplicates. The normal per-database `schema_migrations` ledger records the baseline like any other file.

On an existing database the baseline does not alter columns, rewrite rows or rebuild existing tables' indexes. Missing tables are created with their indexes; no table or column is dropped. A five-second transaction-local lock timeout bounds lock waiting. This is not a drift repair tool: an existing table with an incompatible shape still requires a separately reviewed migration. The transaction can be retried if lock acquisition times out. The baseline is idempotent even if its transaction commits before the runner records its filename.

Workspace/project/team migrations still target `DATABASE_URL`; optional group-chat migrations are not baseline prerequisites. This does not incorporate PR #84's no-transaction executor or PR #86's build gate. If those PRs land first, preserve their executor/gate and keep the explicit baseline ordering when resolving the small runner/package/workflow overlap.

## CI proof

The production/browser job in `.github/workflows/ui-policy.yml` runs `tests/migrate-empty-db.test.mjs` before the existing E2E schema setup. The test requires `CI=true`, an explicit `MIGRATION_BOOTSTRAP_CI=1`, loopback host, the exact `mikka_e2e` database name and PostgreSQL 17. It never falls back to another database URL.

It creates empty disposable schemas inside that service database and invokes `pnpm migrate` with migration opt-in. It covers both shared and separate application/workspace schemas, checks every current Drizzle table/column and nullability, auth/chat-state prerequisites and every tracked migration record. It reruns the command and verifies that schema/index definitions and ledger timestamps stay unchanged, then directly replays the baseline twice against populated user/issue tables and verifies schema/history/data preservation. The test retains its isolated database and schemas for inspection during the CI job; it closes connections without deleting fixtures. No `setup-e2e-db`, schema push or Better Auth migrator is used to satisfy this test.

The test skips without its explicit flag, so ordinary local unit tests cannot connect to a database. Database success is established only by the non-skipped CI step, not that local skip.
