-- target: MIKKA_DATABASE_URL
-- Compatibility for the current issue projection only. Existing Linear
-- functions, triggers, permissions and synchronization settings are unchanged.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE issues ADD COLUMN IF NOT EXISTS "linearSyncBlocked" boolean NOT NULL DEFAULT false;
COMMIT;
