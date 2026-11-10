-- target: DATABASE_URL
-- Archive preserves identity, delivery status, task links and all execution history.
ALTER TABLE workspace_projects ADD COLUMN IF NOT EXISTS "archivedAt" timestamptz;
ALTER TABLE workspace_projects ADD COLUMN IF NOT EXISTS "archivedBy" text;
CREATE INDEX IF NOT EXISTS workspace_projects_archive_idx ON workspace_projects("workspaceId","archivedAt");

-- SQL callers cannot attach new work to an archived Project. The row lock also
-- serializes a concurrent archive with a direct relation insert.
CREATE OR REPLACE FUNCTION mikka_project_require_active_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE archived timestamptz;
BEGIN
  SELECT "archivedAt" INTO archived FROM workspace_projects
    WHERE id=NEW."projectId" AND "workspaceId"=NEW."workspaceId" FOR SHARE;
  IF FOUND AND archived IS NOT NULL THEN
    RAISE EXCEPTION 'projectArchived' USING ERRCODE='23514', CONSTRAINT='workspace_project_active_binding';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS workspace_project_tasks_active ON workspace_project_tasks;
CREATE TRIGGER workspace_project_tasks_active BEFORE INSERT OR UPDATE OF "projectId","workspaceId" ON workspace_project_tasks
  FOR EACH ROW EXECUTE FUNCTION mikka_project_require_active_binding();
DROP TRIGGER IF EXISTS workspace_project_members_active ON workspace_project_members;
CREATE TRIGGER workspace_project_members_active BEFORE INSERT OR UPDATE OF "projectId","workspaceId" ON workspace_project_members
  FOR EACH ROW EXECUTE FUNCTION mikka_project_require_active_binding();
DROP TRIGGER IF EXISTS mikka_team_projects_active_project ON mikka_team_projects;
CREATE TRIGGER mikka_team_projects_active_project BEFORE INSERT OR UPDATE OF "projectId","workspaceId" ON mikka_team_projects
  FOR EACH ROW EXECUTE FUNCTION mikka_project_require_active_binding();
DROP TRIGGER IF EXISTS workspace_project_repositories_active ON workspace_project_repositories;
CREATE TRIGGER workspace_project_repositories_active BEFORE INSERT OR UPDATE OF "projectId","workspaceId" ON workspace_project_repositories
  FOR EACH ROW EXECUTE FUNCTION mikka_project_require_active_binding();
DROP TRIGGER IF EXISTS workspace_project_environments_active ON workspace_project_environments;
CREATE TRIGGER workspace_project_environments_active BEFORE INSERT OR UPDATE OF "projectId","workspaceId" ON workspace_project_environments
  FOR EACH ROW EXECUTE FUNCTION mikka_project_require_active_binding();
