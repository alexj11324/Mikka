-- target: DATABASE_URL
-- Workspace share defaults and sub-agent limits. Saved only; creation and runs do not read them yet (#2956).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE mikka_workspaces ADD COLUMN IF NOT EXISTS "parallelSubagents" integer NOT NULL DEFAULT 8;
ALTER TABLE mikka_workspaces ADD COLUMN IF NOT EXISTS "nestDepth" integer NOT NULL DEFAULT 2;
ALTER TABLE mikka_workspaces ADD COLUMN IF NOT EXISTS "newWorkVisibility" text NOT NULL DEFAULT 'inherit';
ALTER TABLE mikka_workspaces ADD COLUMN IF NOT EXISTS "workspaceWorkVisibility" text NOT NULL DEFAULT 'members';
ALTER TABLE mikka_workspaces ADD COLUMN IF NOT EXISTS "allowPrivate" boolean NOT NULL DEFAULT false;
COMMIT;
