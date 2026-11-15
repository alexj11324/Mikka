ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS "archiveIdleAfterDays" integer NOT NULL DEFAULT 30
  CHECK ("archiveIdleAfterDays" IN (0,3,7,14,30,90));
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "conversationRestoredAt" timestamptz;
