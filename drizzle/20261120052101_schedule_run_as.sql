-- target: MIKKA_DATABASE_URL

BEGIN;
SET LOCAL lock_timeout = '5s';

-- Runs as: the workspace member each run of the automation acts, is billed and posts as. NULL is its creator
-- (owner_id). Who may name whom, and that the person is still an active member, is checked by the schedule writer
-- and again at every run.
ALTER TABLE user_schedules ADD COLUMN IF NOT EXISTS run_as_user_id text REFERENCES "user"(id) ON DELETE SET NULL;

COMMIT;
