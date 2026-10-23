-- MIK-16: title search for the relation picker (GET /api/issues/search).
-- Trigram GIN index so `title ilike '%q%'` can use an index for q of 3+ characters.
-- Shorter q (1–2 characters, e.g. one CJK character) still scans the visible rows.
create extension if not exists pg_trgm;
create index if not exists issues_title_trgm_idx on issues using gin (title gin_trgm_ops);
