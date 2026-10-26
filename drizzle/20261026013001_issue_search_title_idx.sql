-- target: MIKKA_DATABASE_URL
-- One statement, outside a transaction. Do not combine with other SQL.
-- Concurrent creation avoids blocking writes; run migrations serially.
-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS issues_title_search_trgm_idx;
-- If interrupted, inspect pg_index.indisvalid; drop an INVALID index concurrently
-- before rerunning. IF NOT EXISTS does not repair INVALID indexes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS issues_title_search_trgm_idx ON issues USING gin (title gin_trgm_ops);
