-- target: MIKKA_DATABASE_URL

BEGIN;
SET LOCAL lock_timeout = '5s';

-- An automation that posts its runs to Slack posts each finished run once (decision 2026-11-15-2040).
ALTER TABLE schedule_occurrences ADD COLUMN IF NOT EXISTS notified_at timestamptz;

COMMIT;
