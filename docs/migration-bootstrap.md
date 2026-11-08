# Migration bootstrap

Use this guide to initialize an isolated database and understand the migrations
run by the production release. `MIGRATE=1 pnpm migrate` applies tracked SQL to
the application (`MIKKA_DATABASE_URL`) and workspace (`DATABASE_URL`) databases.
Try migrations against the isolated `mikka_e2e` database in cloud Linux.

`pnpm build` runs the subscription-worker build, Agent UI generation, Vite
frontend and Nitro API build, type checks, then `scripts/migrate.mjs`.
`pnpm build:app` only builds the application and omits migrations. The
[Web release](operations/web-deploy.md) runs the full build on GitHub Actions
with production configuration before uploading prebuilt output to Vercel.
The migration runner applies in Vercel production, with explicit `MIGRATE=1`,
or outside Vercel when every target is loopback. `MIGRATE=0` skips before
database access. Remote opt-in outside Vercel also requires `--allow-remote`.
Unrequested Vercel Preview and remote CI builds skip. Production requires
`VERCEL_GIT_COMMIT_REF=main`.

A failed migration stops publication while the previous deployment serves.
Completed files may already have committed, so every migration must remain
compatible with the live code. The two database targets have separate commits.

## The pre-history baseline

The numbered migrations originally assumed that issue/editor/agent-session tables and Better Auth's core tables already existed. `20261023221259_application_baseline.sql` supplies those prerequisites on an empty database. Its timestamp follows the migration naming rule; `scripts/migration-order.mjs` explicitly puts this one named file before `0001`. Every other migration retains its filename and relative lexical ordering, including the frozen historical duplicates. The normal per-database `schema_migrations` ledger records the baseline like any other file.

On an existing database the baseline does not alter columns, rewrite rows or rebuild existing tables' indexes. Missing tables are created with their indexes; no table or column is dropped. A five-second transaction-local lock timeout bounds lock waiting. This is not a drift repair tool: an existing table with an incompatible shape still requires a separately reviewed migration. The transaction can be retried if lock acquisition times out. The baseline is idempotent even if its transaction commits before the runner records its filename.

Workspace/project/team migrations still target `DATABASE_URL`; optional group-chat migrations are not baseline prerequisites. A file can declare `-- migrate: no-transaction` for one standalone statement (`scripts/migration-steps.mjs`).

## CI proof

Selected database check jobs (`Database checks (n/N)`, up to four shards) in
`.github/workflows/ui-policy.yml` run `tests/migrate-empty-db.test.mjs` before
the isolated schema setup. [CI selection](ci/incremental.md) decides whether
these jobs run. The test requires `CI=true`, an explicit `MIGRATION_BOOTSTRAP_CI=1`, loopback host, the exact `mikka_e2e` database name and PostgreSQL 17. It never falls back to another database URL.

It creates empty disposable schemas inside that service database and invokes `pnpm migrate` with migration opt-in. It covers both shared and separate application/workspace schemas, checks every current Drizzle table/column and nullability, auth/chat-state prerequisites and every tracked migration record. It reruns the command and verifies that schema/index definitions and ledger timestamps stay unchanged, then directly replays the baseline twice against populated user/issue tables and verifies schema/history/data preservation. The test retains its isolated database and schemas for inspection during the CI job; it closes connections without deleting fixtures. No `setup-e2e-db`, schema push or Better Auth migrator is used to satisfy this test.

The test skips without its explicit flag, so ordinary local unit tests cannot connect to a database. Database success is established only by the non-skipped CI step, not that local skip.
