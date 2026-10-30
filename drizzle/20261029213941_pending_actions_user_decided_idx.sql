-- target: MIKKA_DATABASE_URL
-- migrate: no-transaction
-- Activity timeline: decided proposals per user. Built CONCURRENTLY so writes to pending_actions
-- are not blocked. If a previous build failed and left an INVALID index, scripts/migrate.mjs drops it
-- (DROP INDEX CONCURRENTLY, after checking pg_index.indisvalid) and runs this file again.
CREATE INDEX CONCURRENTLY IF NOT EXISTS pending_actions_user_decided_idx ON pending_actions ("userId", "decidedAt" DESC) WHERE "decidedAt" IS NOT NULL;
