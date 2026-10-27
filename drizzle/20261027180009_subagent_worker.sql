ALTER TABLE bot_subagents ADD COLUMN IF NOT EXISTS "workerKey" text;
CREATE UNIQUE INDEX IF NOT EXISTS bot_subagents_worker_key_idx ON bot_subagents("workerKey") WHERE "workerKey" IS NOT NULL;
