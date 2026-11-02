-- target: MIKKA_DATABASE_URL
-- When a workspace was deleted (decision 2026-11-02-0230). The workspace row
-- itself is gone, so the main database records it here, in the same
-- transaction that deletes the workspace's rows (lib/workspace-rows.ts). The
-- audit-retention job removes its audit events at "deletedAt" + 90 days and
-- then this row (lib/audit/retention.ts).
-- The key is "id", not "workspaceId": where both database targets share one
-- database, the account-deletion guard puts a trigger on every table with a
-- "workspaceId" column, and account deletion writes this row while its guard
-- on the person's own workspaces is held.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS workspace_deletions (
  id uuid PRIMARY KEY,
  "deletedAt" timestamptz NOT NULL DEFAULT now()
);
COMMIT;
