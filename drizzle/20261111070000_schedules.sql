-- target: MIKKA_DATABASE_URL
BEGIN;
ALTER TABLE user_schedules ADD COLUMN visibility text NOT NULL DEFAULT 'owner'
  CHECK (visibility IN ('owner','workspace'));
ALTER TABLE user_schedules ADD CONSTRAINT user_schedules_workspace_visibility
  CHECK (visibility='owner' OR workspace_id IS NOT NULL);
ALTER TABLE user_schedules DROP CONSTRAINT user_schedules_bot_id_fkey;
ALTER TABLE user_schedules ADD CONSTRAINT user_schedules_bot_id_fkey
  FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE SET NULL;
CREATE INDEX user_schedules_workspace ON user_schedules(workspace_id, created_at DESC);
CREATE INDEX user_schedules_workspace_due ON user_schedules(workspace_id, next_at) WHERE status='active';
COMMIT;
