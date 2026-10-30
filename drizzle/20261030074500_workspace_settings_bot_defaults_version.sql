-- target: MIKKA_DATABASE_URL
-- Optimistic lock for 新 Bot 默认值 (BE-15). A constant DEFAULT makes ADD COLUMN metadata-only
-- (no table rewrite); the ACCESS EXCLUSIVE lock is brief and bounded by lock_timeout.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS "botDefaultsVersion" integer NOT NULL DEFAULT 0;
COMMIT;
