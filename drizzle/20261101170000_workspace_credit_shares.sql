-- target: MIKKA_DATABASE_URL
-- Decision 2026-10-31-2300 item 4, orchestration.md § 7: a person may share
-- their credits (their personal workspace's balance) with a team workspace by
-- opting in, as with a card designation. While the team's own balance is
-- empty, its Mikka 默认 calls are paid from sharers' balances, oldest share
-- first. Stopping it, or leaving the team, deletes the row at once.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE IF NOT EXISTS workspace_credit_shares (
  "workspaceId" uuid NOT NULL,
  "userId" text NOT NULL,
  "sharedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspaceId", "userId")
);
COMMIT;
