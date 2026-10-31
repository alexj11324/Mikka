-- Decision 2026-10-31-2130: a team admin can switch off members' personal
-- subscriptions, app connections and devices for that workspace. All on by
-- default; an absent row means all on. Admins never see or use the items.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE IF NOT EXISTS workspace_personal_policies (
  "workspaceId" uuid PRIMARY KEY,
  subscriptions boolean NOT NULL DEFAULT true,
  apps boolean NOT NULL DEFAULT true,
  devices boolean NOT NULL DEFAULT true,
  "updatedBy" text,
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
COMMIT;
