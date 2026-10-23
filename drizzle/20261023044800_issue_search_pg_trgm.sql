-- MIK-16: title search for the relation picker (GET /api/issues/search).
-- pg_trgm for the trigram index in 20261023044801_issue_title_trgm_idx.sql.
-- Normal (transactional) migration. Before prod: confirm the migration role may
-- CREATE EXTENSION pg_trgm, or that it is already installed.
create extension if not exists pg_trgm;
