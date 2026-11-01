-- The Coordinator is a bot too (glossary): each owner gets one hidden
-- Coordinator row per workspace, so its cloud runs have their own runtime
-- (bot_cloud_runtimes, bot_desktops) and never borrow another bot's (#727).
-- It is never listed; a person may still name a bot "Coordinator".
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE bots ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'bot';
DO $$ BEGIN
  ALTER TABLE bots ADD CONSTRAINT bots_kind_check CHECK (kind IN ('bot', 'coordinator'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS bots_coordinator_key ON bots ("ownerId", "workspaceId") WHERE kind = 'coordinator';
DROP INDEX IF EXISTS bots_owner_workspace_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS bots_owner_workspace_name_key ON bots ("ownerId", "workspaceId", lower(name)) WHERE kind = 'bot';
COMMIT;
