-- target: DATABASE_URL
-- Workspace settings › General: an optional icon and the slugs a workspace used
-- before, so old /w/<slug> links still reach it after a rename. Additive only.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
-- A small image data URL (≤200 KB decoded, png/jpeg/webp/gif), validated by the server action.
ALTER TABLE mikka_workspaces ADD COLUMN IF NOT EXISTS icon text;
CREATE TABLE IF NOT EXISTS mikka_workspace_slug_redirects (
  slug varchar(64) PRIMARY KEY,
  "workspaceId" uuid NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mikka_workspace_slug_redirects_workspace_idx ON mikka_workspace_slug_redirects ("workspaceId");
COMMIT;
