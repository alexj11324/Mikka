-- migrate: no-transaction
-- MIK-16: trigram GIN index so `title ilike '%q%'` can use an index for q of 3+ characters.
-- Shorter q (1–2 characters, e.g. one CJK character) still scans the visible rows.
-- Built CONCURRENTLY so issues stays writable (needs #84). migrate.mjs checks indisvalid; if the
-- build fails, run DROP INDEX CONCURRENTLY IF EXISTS issues_title_trgm_idx; and deploy again.
-- Before prod: check the issues row count to estimate build time.
create index concurrently if not exists issues_title_trgm_idx on issues using gin (title gin_trgm_ops);
