-- target: DATABASE_URL
-- Reusable run environments: setup/install scripts and user-triggered actions.
-- A row is versioned per workspace and may be scoped to one project. Runs never
-- read the live row: their frozen snapshot lives in MIKKA_DATABASE_URL
-- (20261110170001_run_environment_bindings.sql).
CREATE TABLE IF NOT EXISTS project_environments (
  id uuid PRIMARY KEY,
  "ownerId" text NOT NULL,
  "workspaceId" uuid NOT NULL REFERENCES mikka_workspaces(id) ON DELETE CASCADE,
  "projectId" uuid REFERENCES workspace_projects(id) ON DELETE CASCADE,
  name varchar(80) NOT NULL,
  description varchar(600) NOT NULL DEFAULT '',
  runtime text NOT NULL CHECK (runtime IN ('cloud','local')),
  workdir varchar(200) NOT NULL DEFAULT '',
  "setupScript" text NOT NULL DEFAULT '',
  "installScript" text NOT NULL DEFAULT '',
  actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  repositories jsonb NOT NULL DEFAULT '[]'::jsonb,
  "isDefault" boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  "archivedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CHECK (revision > 0),
  CHECK (jsonb_typeof(actions) = 'array' AND jsonb_array_length(actions) <= 12),
  CHECK (jsonb_typeof(repositories) = 'array' AND jsonb_array_length(repositories) <= 20),
  CHECK (octet_length(name) BETWEEN 1 AND 320),
  CHECK (octet_length("setupScript") <= 16000 AND octet_length("installScript") <= 16000)
);
CREATE INDEX IF NOT EXISTS project_environments_workspace_idx
  ON project_environments ("workspaceId", "archivedAt", lower(name));
CREATE INDEX IF NOT EXISTS project_environments_project_idx
  ON project_environments ("projectId") WHERE "projectId" IS NOT NULL;
-- One default per scope: the whole workspace, or one project.
CREATE UNIQUE INDEX IF NOT EXISTS project_environments_workspace_default
  ON project_environments ("workspaceId") WHERE "isDefault" AND "projectId" IS NULL AND "archivedAt" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS project_environments_project_default
  ON project_environments ("projectId") WHERE "isDefault" AND "projectId" IS NOT NULL AND "archivedAt" IS NULL;
-- Active names are unique inside their scope, case-insensitively.
CREATE UNIQUE INDEX IF NOT EXISTS project_environments_workspace_name
  ON project_environments ("workspaceId", lower(name)) WHERE "projectId" IS NULL AND "archivedAt" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS project_environments_project_name
  ON project_environments ("projectId", lower(name)) WHERE "projectId" IS NOT NULL AND "archivedAt" IS NULL;

-- Immutable configuration history. Every save appends one row; a run binding
-- names the revision it froze.
CREATE TABLE IF NOT EXISTS project_environment_revisions (
  "environmentId" uuid NOT NULL REFERENCES project_environments(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  config jsonb NOT NULL,
  "createdBy" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("environmentId", revision),
  CHECK (revision > 0),
  CHECK (jsonb_typeof(config) = 'object')
);

-- A closing account cannot create environments after its sweep begins.
DROP TRIGGER IF EXISTS account_deletion_insert_guard ON project_environments;
CREATE TRIGGER account_deletion_insert_guard BEFORE INSERT ON project_environments
  FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_insert('ownerId');
