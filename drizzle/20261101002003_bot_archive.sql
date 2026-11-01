-- Decision 2026-10-31-2225 (§8.3): when a member leaves a team, or is suspended,
-- their bots there are archived (paused) until an admin takes one over.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE bots ADD COLUMN IF NOT EXISTS "archivedAt" timestamptz;
COMMIT;
