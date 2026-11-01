-- The Coordinator is an ordinary bot row (lib/coordinator/coordinator-bot.ts):
-- each Coordinator chat entry stores the bot whose chat it belongs to where it
-- enters, so later writes (a decision, a send) read it and never resolve the
-- Coordinator again. A card the person decides goes back to the chat that
-- proposed it; a suggestion goes to the person's Coordinator. Null only on
-- rows written before this; those go to the Coordinator's chat as before.
-- Additive and rerunnable. No FK: a deleted bot leaves the row as history.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS "botId" uuid;
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS "botId" uuid;
COMMIT;
