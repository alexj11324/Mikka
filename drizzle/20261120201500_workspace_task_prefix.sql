-- target: DATABASE_URL
-- Workspace profile: the workspace's own task prefix. Issued identifiers stay unchanged.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE mikka_workspaces ADD COLUMN IF NOT EXISTS "taskPrefix" varchar(4);
COMMIT;
