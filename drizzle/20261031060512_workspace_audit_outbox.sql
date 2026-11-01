-- target: DATABASE_URL
BEGIN;
SET LOCAL lock_timeout='5s';
-- Audit intent must commit with the workspace change, independently of the main audit store.
-- No FK cascade: deleting the subject/workspace cannot erase undelivered accountability evidence.
CREATE TABLE workspace_audit_outbox (
 id uuid PRIMARY KEY,
 "workspaceId" uuid NOT NULL,
 payload jsonb,
 "createdAt" timestamptz NOT NULL DEFAULT now(),
 "lastAttemptAt" timestamptz,
 "deliveredAt" timestamptz,
 CHECK(("deliveredAt" IS NULL AND payload IS NOT NULL AND jsonb_typeof(payload)='object' AND (payload->>'workspaceId') IS NOT DISTINCT FROM "workspaceId"::text)
    OR ("deliveredAt" IS NOT NULL AND payload IS NULL))
);
CREATE INDEX workspace_audit_outbox_pending_idx ON workspace_audit_outbox(COALESCE("lastAttemptAt",'epoch'::timestamptz),"createdAt",id) WHERE "deliveredAt" IS NULL;
COMMIT;
