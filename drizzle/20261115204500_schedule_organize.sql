-- target: MIKKA_DATABASE_URL

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 自动化 folders and tags are the workspace's, set by an automation's creator or an owner/admin; a pin is each person's
-- own (decision 2026-11-15-2100).
ALTER TABLE user_schedules ADD COLUMN IF NOT EXISTS folder text;
ALTER TABLE user_schedules ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS schedule_pins (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  schedule_id uuid NOT NULL REFERENCES user_schedules(id) ON DELETE CASCADE,
  pinned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, schedule_id)
);

COMMIT;
