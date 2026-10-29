# Issue read compatibility · 2026-10-29

The deployed issue model includes `issues.linearSyncBlocked`, but the production database inspected during #408 lacks that column. `issueForUser` calls `findIssueForUser` with a Drizzle projection of the whole issue row, so unrelated issue/Factory reads also require it. This candidate adds only that existing model field.

Source: `drizzle/20261029160411_issue_read_compatibility.sql`. Target: `MIKKA_DATABASE_URL`. It is additive, transaction-bound, uses a five-second lock timeout and sixty-second statement timeout, and preserves an existing column and its values on replay. Existing rows expose the constant `false` default; there is no row UPDATE or backfill statement. Adding the column still requires an ACCESS EXCLUSIVE table lock. This does not establish a zero-lock migration.

The candidate does not replace `enqueue_linear_issue_sync()`, install publication-gate triggers, change Linear enablement, assign an issue's target or grant any provider permission. In particular it is **not** an alias or replacement ledger entry for `20261029043641_team_issue_creation_gate.sql`: that larger source remains unapplied by this task. Its other tables/functions/triggers are not supplied by this compatibility column. Do not record the larger migration as applied.

No production SQL is authorized or executed by this candidate. The separately approved `deviceCode` migration is excluded, as are Linear migration bodies, the optional persistent computer-allow mode, new credential access and paid provisioning. Other per-feature dependencies from PR #409 remain separate; this column alone does not make Factory or provider execution available.

Verification must cover the real PostgreSQL legacy shape without this column, retaining an existing synthetic issue and existing trigger/function definitions. Apply this candidate only, confirm boolean/NOT NULL/default and the same issue contents, then replay after setting a synthetic row's field to true and confirm it is preserved. Snapshot trigger/function definitions and emitted fixture events before/after each DDL application; DDL must not rewrite the fixture or alter synchronization definitions. Retain the isolated fixtures for review rather than modifying production or deleting retained data.

## Verification completed

SHA-256: `20b051737e255e5ccc70a790693822d024af1f6dc2062f6ae69406cef7ef44a6`. The existing planner recognizes `MIKKA_DATABASE_URL`, transactional mode and no historical alias. The migration-order check passes (118 tracked sources).

On dedicated local PostgreSQL `mikka_rollout_final_e2e`, fixture schema `issue_read_compat_e63dea7b46b740e1a0d547d7622a71bf` began with a populated legacy issue table and a fixture synchronization function/trigger. The existing executor applied this single candidate; the original row remained intact, the new column is boolean/NOT NULL/default false, function and trigger definitions were unchanged and DDL emitted no fixture row events. Direct replay after setting the synthetic field to true preserved that value and all definitions/events. The normal runner recognizes the one recorded migration and skips replay. Public Linear-function definition digests in this isolated database also stayed unchanged. The fixture schema, rows and history remain retained; nothing was applied to production.

Independent source review found no required fix. The current production trigger was separately inspected read-only: it selects named existing issue columns and is not replaced or invoked by this DDL. This does not establish every application write path: current team creation/promotion and workers also use the field, while this candidate deliberately does not install the larger migration's publication protections. Those paths must not be declared available merely because the projection now has a column.

## Execution and recovery boundary

The production candidate remains unapproved and unexecuted. If later approved, recheck its exact hash, target, column shape/history and existing recovery window. Apply only this bounded source with lock/statement limits; do not run the all-pending command. The normal `applyMigration` executes the file's COMMIT before its separate history INSERT, so using that helper alone does not make DDL and ledger atomic. An approved execution must either use a separately reviewed atomic transaction adaptation or explicitly check both column and ledger after any uncertain response; do not infer success or blindly retry.

An error before COMMIT rolls back the file transaction. After success, retain the column and all future values, and revert application code if necessary. Automatic DROP, resetting true values, data cleanup and recording `43641` as applied are outside this candidate.
