BEGIN;
SET LOCAL lock_timeout='5s';
-- No row or NULL days means retain. No legal retention period is chosen here.
CREATE TABLE workspace_audit_retention (
 "workspaceId" uuid PRIMARY KEY,
 "retentionDays" integer CHECK("retentionDays" BETWEEN 1 AND 36500),
 "legalHold" boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1,
 "configuredBy" text NOT NULL,
 "updatedAt" timestamptz NOT NULL DEFAULT now()
);
COMMIT;
