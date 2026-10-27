-- target: MIKKA_DATABASE_URL
-- One statement, outside a transaction. Serial migration execution required.
-- Exact-number search uses this owner + metadata expression index.
-- Rollback: DROP INDEX CONCURRENTLY IF EXISTS issues_owner_number_search_idx;
-- After interruption inspect validity; drop an INVALID index before replay.
CREATE INDEX CONCURRENTLY IF NOT EXISTS issues_owner_number_search_idx ON issues ("userId", ((coalesce(content->'attrs'->'mikka', content->'attrs'->'orvilo'))->>'number'));
