-- migrate: no-transaction
-- MIK-16: title search for the relation picker (GET /api/issues/search).
-- Trigram GIN index so `title ilike '%q%'` can use an index for q of 3+ characters.
-- Shorter q (1–2 characters, e.g. one CJK character) still scans the visible rows.
-- Built CONCURRENTLY so issues stays writable; needs migrate.mjs no-transaction support (PR #84).
-- If the build fails it leaves an INVALID index that IF NOT EXISTS would skip:
-- drop index concurrently if exists issues_title_trgm_idx; then rerun.
-- Before prod: confirm the migration role may CREATE EXTENSION pg_trgm (or it is already
-- installed) and check the issues row count to estimate build time.
create extension if not exists pg_trgm;
create index concurrently if not exists issues_title_trgm_idx on issues using gin (title gin_trgm_ops);
