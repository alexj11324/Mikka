-- target: MIKKA_DATABASE_URL
-- A bot in a shared workspace outlives its owner's account (decision
-- 2026-11-02-0230): account deletion pauses it with a NULL owner, 「待接管」,
-- until an admin takes it over (lib/account/delete.ts, takeOverBot). The owner
-- foreign key sets NULL instead of cascading; account deletion removes the
-- person's other bots explicitly.
-- Composite foreign keys onto bots(id, "workspaceId", "ownerId") are MATCH
-- SIMPLE: a referencing row is only checked while all three are non-null, and
-- their owner-bound rows are deleted before an owner is cleared.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE bots ALTER COLUMN "ownerId" DROP NOT NULL;
ALTER TABLE bots DROP CONSTRAINT IF EXISTS "bots_ownerId_fkey";
-- NOT VALID: only a brief lock here; existing rows are checked by VALIDATE
-- CONSTRAINT in its own transaction (20261102031001).
ALTER TABLE bots ADD CONSTRAINT "bots_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user"(id) ON DELETE SET NULL NOT VALID;
COMMIT;
