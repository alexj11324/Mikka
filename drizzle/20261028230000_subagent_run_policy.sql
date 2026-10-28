-- Additive policy snapshot for a server-created web run. Existing rows stay
-- NULL and fail closed; no policy is fabricated for an already-active run.
ALTER TABLE bot_subagents ADD COLUMN IF NOT EXISTS "runPolicy" jsonb;
COMMENT ON COLUMN bot_subagents."runPolicy" IS
  'Trusted host policy snapshot, never supplied by model/browser input';
