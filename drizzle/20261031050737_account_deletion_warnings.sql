BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE account_deletion_jobs ADD COLUMN warnings jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(warnings)='array');
COMMIT;
