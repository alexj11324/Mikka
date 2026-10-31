-- target: DATABASE_URL
BEGIN;
SET LOCAL lock_timeout = '5s';
-- No TTL deletion is chosen here. Snapshot links expire; operators retain the
-- content-free manifest/row digests independently from the application events.
CREATE TABLE workspace_audit_exports (
  id uuid PRIMARY KEY,
  "workspaceId" uuid NOT NULL,
  "createdBy" text NOT NULL,
  manifest jsonb NOT NULL,
  records jsonb NOT NULL CHECK (jsonb_typeof(records)='array'),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "expiresAt" timestamptz NOT NULL,
  CHECK (jsonb_array_length(records)<=50000)
);
CREATE INDEX workspace_audit_exports_workspace_idx ON workspace_audit_exports("workspaceId","createdAt" DESC);
COMMIT;
