-- target: MIKKA_DATABASE_URL
-- One statement, outside a transaction. Serial migration execution required.
-- Supports owner-scoped recency/keyset reads. No data rewrite.
-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS issues_owner_updated_id_idx;
-- After interruption inspect validity; drop an INVALID index before replay.
CREATE INDEX CONCURRENTLY IF NOT EXISTS issues_owner_updated_id_idx ON issues ("userId", "updatedAt" DESC, id DESC);
