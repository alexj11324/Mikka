-- target: MIKKA_DATABASE_URL
-- Sandboxes whose machine rows went with a deleted workspace but whose kill
-- has not been acknowledged yet (lib/cloud-computer/workspace-teardown.ts).
-- Written in the transaction that fences the machines, before any kill, and
-- removed when E2B confirms the kill or reports the sandbox gone; the
-- run-recovery cron retries the rest on the owner's own key. It holds no key
-- or credential: only who owns the sandbox and its id.
-- No "workspaceId" column on purpose: deleting a workspace deletes every
-- main-database row keyed by it (lib/workspace-rows.ts), and these rows must
-- outlive it.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS sandbox_kill_retries (
  "sandboxId" text PRIMARY KEY,
  "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  attempts integer NOT NULL DEFAULT 0,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "lastAttemptAt" timestamptz
);
CREATE INDEX IF NOT EXISTS sandbox_kill_retries_owner_idx ON sandbox_kill_retries ("ownerId");
COMMIT;
