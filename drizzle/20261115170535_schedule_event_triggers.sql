-- target: MIKKA_DATABASE_URL

BEGIN;
SET LOCAL lock_timeout = '5s';

-- An automation run started by an event (a GitHub delivery) keeps the event it
-- ran on and the indexes of the triggers that took it (decision 2026-11-15-1704).
ALTER TABLE schedule_occurrences ADD COLUMN IF NOT EXISTS trigger jsonb;

-- Incoming events look up active automations that have event triggers.
CREATE INDEX IF NOT EXISTS user_schedules_event_triggers ON user_schedules(id)
  WHERE status = 'active' AND definition ? 'events';

COMMIT;
