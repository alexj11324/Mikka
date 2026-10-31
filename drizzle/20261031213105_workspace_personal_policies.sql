-- Decision 2026-10-31-2225: subscriptions belong to the person. A member
-- shares theirs into a team workspace themselves (在这里使用我的订阅), for
-- their own bots only; a team admin has one switch, 允许成员使用个人订阅, on by
-- default (an absent row means on), and never sees or uses the subscription.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE IF NOT EXISTS workspace_personal_policies (
  "workspaceId" uuid PRIMARY KEY,
  subscriptions boolean NOT NULL DEFAULT true,
  "updatedBy" text,
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workspace_subscription_shares (
  "ownerId" text NOT NULL,
  "workspaceId" uuid NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("ownerId", "workspaceId")
);
CREATE INDEX IF NOT EXISTS workspace_subscription_shares_workspace_idx ON workspace_subscription_shares ("workspaceId");
-- Nothing stops working: every subscription stays shared where it was connected.
INSERT INTO workspace_subscription_shares ("ownerId", "workspaceId")
SELECT DISTINCT "ownerId", "workspaceId"::uuid FROM byos_connections
WHERE "removedAt" IS NULL AND "workspaceId" ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
ON CONFLICT DO NOTHING;
COMMIT;
