-- target: MIKKA_DATABASE_URL
-- Second half of the bot_subagents owner FK from 20261029213939 (added NOT VALID there).
-- Separate file = separate transaction: VALIDATE takes SHARE UPDATE EXCLUSIVE, so reads and
-- writes continue while existing rows are checked. Validating an already valid FK is a no-op.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';
ALTER TABLE bot_subagents VALIDATE CONSTRAINT "bot_subagents_botId_workspaceId_ownerId_fkey";
COMMIT;
