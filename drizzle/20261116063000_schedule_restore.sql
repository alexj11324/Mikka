-- target: MIKKA_DATABASE_URL
BEGIN;
SET LOCAL lock_timeout = '5s';
-- Existing terminal cancellations have no saved state and remain terminal.
ALTER TABLE user_schedules ADD COLUMN IF NOT EXISTS status_before_delete text
  CHECK (status_before_delete IS NULL OR
    (status='cancelled' AND status_before_delete IN ('active','paused','completed')));
COMMIT;
