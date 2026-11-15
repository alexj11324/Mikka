-- target: MIKKA_DATABASE_URL

BEGIN;
SET LOCAL lock_timeout = '5s';

-- An automation's webhook URL carries a secret; only its SHA-256 is kept
-- (decision 2026-11-15-1830). A new URL replaces the hash, so the old one stops working.
ALTER TABLE user_schedules ADD COLUMN IF NOT EXISTS webhook_key_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS user_schedules_webhook_key ON user_schedules(webhook_key_hash) WHERE webhook_key_hash IS NOT NULL;

COMMIT;
