ALTER TABLE bot_subagents ADD COLUMN IF NOT EXISTS "idempotencyKey" text;
ALTER TABLE bot_subagents ADD COLUMN IF NOT EXISTS "controlledBy" text;
ALTER TABLE bot_subagents ADD COLUMN IF NOT EXISTS "controlUntil" timestamptz;
ALTER TABLE bot_subagents ADD COLUMN IF NOT EXISTS epoch integer NOT NULL DEFAULT 0;
ALTER TABLE bot_subagents ADD COLUMN IF NOT EXISTS "startedAt" timestamptz;
ALTER TABLE bot_subagents ADD COLUMN IF NOT EXISTS needs text;
ALTER TABLE bot_subagents ADD COLUMN IF NOT EXISTS result text;
CREATE UNIQUE INDEX IF NOT EXISTS bot_subagents_idempotency_idx ON bot_subagents("ownerId", "workspaceId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;
