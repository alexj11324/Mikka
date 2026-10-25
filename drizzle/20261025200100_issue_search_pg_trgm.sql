-- target: MIKKA_DATABASE_URL
-- Title substring search needs pg_trgm; no task/user rows change.
-- Requires extension-install permission. Extension is shared: rollback must not
-- drop it if another feature uses it. Idempotent; run migrations serially.
-- Keep shared extension objects visible to migrations in isolated schemas.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
