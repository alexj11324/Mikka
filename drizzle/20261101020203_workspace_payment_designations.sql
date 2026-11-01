-- Decision 2026-10-31-2225: a member may pay for a team with their own card
-- (由我的卡支付这个团队). One designation per workspace. When the member stops
-- it or leaves, it is released with a grace period instead of an instant
-- cut-off, and the team's admins see it on 计费. Which Stripe customer is
-- charged does not change here (a follow-up Alex confirms first).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE IF NOT EXISTS workspace_payment_designations (
  "workspaceId" uuid PRIMARY KEY,
  "userId" text NOT NULL,
  "designatedAt" timestamptz NOT NULL DEFAULT now(),
  "releasedAt" timestamptz,
  "graceUntil" timestamptz,
  CHECK (("releasedAt" IS NULL) = ("graceUntil" IS NULL))
);
COMMIT;
