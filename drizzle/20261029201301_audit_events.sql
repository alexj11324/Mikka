-- target: MIKKA_DATABASE_URL
-- Workspace audit log (lib/audit). Mirrors auditEvents in lib/db/security-schema.ts.
-- Reads keep 90 days; the daily /api/cron/audit-cleanup job deletes older rows.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY,
  "workspaceId" uuid NOT NULL,
  "actorId" text,
  action text NOT NULL,
  category text NOT NULL CHECK (category IN ('security', 'members', 'secrets', 'permissions', 'workspace')),
  target text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  ip text,
  "userAgent" text,
  country text,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_workspace_idx ON audit_events ("workspaceId", "createdAt" DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_events_category_idx ON audit_events ("workspaceId", category, "createdAt" DESC);
CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events ("createdAt");
COMMIT;
