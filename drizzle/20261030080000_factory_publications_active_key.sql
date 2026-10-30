-- target: MIKKA_DATABASE_URL
-- migrate: no-transaction
-- BE-4 retry: a publication the provider confirmed as failed must not block a fresh attempt at the
-- same (task, candidate, action, target). Failed rows are kept for audit, only non-failed rows stay
-- unique. Built CONCURRENTLY so publication writes are not blocked, and scripts/migrate.mjs checks
-- pg_index.indisvalid and rebuilds an INVALID leftover. 20261030080100 then drops the old UNIQUE.
-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS factory_publications_active_key (only after re-adding the old UNIQUE).
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS factory_publications_active_key ON factory_publications ("taskId", "candidateId", action, target) WHERE status <> 'failed';
