-- target: MIKKA_DATABASE_URL
-- Organization belongs to the root of the run chain, including for task-free conversations.
-- Rolling back the application can leave both nullable columns in place.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "conversationArchivedAt" timestamptz;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "conversationPinnedAt" timestamptz;
