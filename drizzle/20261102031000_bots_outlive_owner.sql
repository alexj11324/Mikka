-- target: MIKKA_DATABASE_URL
-- A bot in a shared workspace outlives its owner's account: account deletion
-- pauses it for an admin to take over, with its threads (lib/account/delete.ts,
-- decision 2026-11-02-0230). "ownerId" keeps the departed id until then, so it
-- no longer cascades from "user". Account deletion removes every other bot of
-- the person explicitly.
SET LOCAL lock_timeout = '5s';
ALTER TABLE bots DROP CONSTRAINT IF EXISTS "bots_ownerId_fkey";
