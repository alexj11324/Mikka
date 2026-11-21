-- target: MIKKA_DATABASE_URL

BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE account_deletion_jobs ADD COLUMN IF NOT EXISTS "blockerErrors" jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof("blockerErrors")='object');
COMMIT;
