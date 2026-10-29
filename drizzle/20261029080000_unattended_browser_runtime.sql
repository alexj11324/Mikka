-- Additive runtime progress only. No historical permission is widened.
ALTER TABLE bot_subagents ADD COLUMN IF NOT EXISTS "consecutiveFailures" integer NOT NULL DEFAULT 0;
ALTER TABLE bot_subagents ADD COLUMN IF NOT EXISTS "lastFailureCode" text;
ALTER TABLE bot_subagents ADD COLUMN IF NOT EXISTS "nextAttemptAt" timestamptz;
ALTER TABLE bot_subagents ADD COLUMN IF NOT EXISTS "activeSteps" integer NOT NULL DEFAULT 0;
ALTER TABLE bot_subagents ADD COLUMN IF NOT EXISTS "startLeaseId" uuid;
ALTER TABLE bot_subagents ADD COLUMN IF NOT EXISTS "startLeaseUntil" timestamptz;
ALTER TABLE bot_subagents ADD COLUMN IF NOT EXISTS "activeActionId" uuid;
