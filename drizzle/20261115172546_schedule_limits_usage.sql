-- target: MIKKA_DATABASE_URL

BEGIN;
SET LOCAL lock_timeout = '5s';

-- An automation paused by the host because its creator's authority no longer
-- holds says why (decision 2026-11-15-1730); resuming clears it.
ALTER TABLE user_schedules ADD COLUMN IF NOT EXISTS disabled_reason text;

-- The daily run cap and per-day usage count an automation's runs by day.
CREATE INDEX IF NOT EXISTS schedule_occurrences_schedule_created ON schedule_occurrences(schedule_id, created_at);

COMMIT;
