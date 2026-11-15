-- target: MIKKA_DATABASE_URL

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 自动化 page requests come from a signed-in person, not a chat message: they
-- carry no source event, and their request IDs live in their own 'page' origin.
ALTER TABLE user_schedules ALTER COLUMN source_event_id DROP NOT NULL;
ALTER TABLE user_schedules DROP CONSTRAINT IF EXISTS user_schedules_request_source;
ALTER TABLE user_schedules ADD CONSTRAINT user_schedules_request_source
  CHECK (source_event_id IS NOT NULL OR request_origin = 'page') NOT VALID;
ALTER TABLE user_schedules VALIDATE CONSTRAINT user_schedules_request_source;

COMMIT;
