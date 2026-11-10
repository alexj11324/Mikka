-- target: DATABASE_URL
-- Team is a removable grouping, never the tenant of its tasks/projects.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE mikka_teams ADD COLUMN IF NOT EXISTS "archivedAt" timestamptz;
ALTER TABLE mikka_teams ADD COLUMN IF NOT EXISTS "archivedBy" text;
CREATE INDEX IF NOT EXISTS mikka_teams_workspace_lifecycle_idx ON mikka_teams ("workspaceId", "archivedAt");

CREATE TABLE IF NOT EXISTS team_lifecycle_events (
  id uuid PRIMARY KEY,
  "workspaceId" uuid NOT NULL REFERENCES mikka_workspaces(id) ON DELETE CASCADE,
  "teamId" uuid NOT NULL,
  "actorId" text NOT NULL,
  action text NOT NULL CHECK (action IN ('archived', 'restored', 'grouping_removed', 'deleted')),
  snapshot jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS team_lifecycle_events_workspace_team_idx
  ON team_lifecycle_events ("workspaceId", "teamId", "createdAt");

-- Existing legacy rows stay readable. A personal workspace cannot gain a team.
CREATE OR REPLACE FUNCTION check_team_workspace_kind() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM mikka_workspaces WHERE id = NEW."workspaceId" AND kind = 'team') THEN
    RAISE EXCEPTION 'teamPersonalWorkspace' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS check_team_workspace_kind ON mikka_teams;
CREATE TRIGGER check_team_workspace_kind BEFORE INSERT OR UPDATE OF "workspaceId" ON mikka_teams
  FOR EACH ROW EXECUTE FUNCTION check_team_workspace_kind();

-- SHARE conflicts with archive/delete row locks, including direct SQL writers.
-- Existing archived links remain readable and may be unassigned or moved away.
CREATE OR REPLACE FUNCTION check_active_team_relation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_workspace uuid; archived_at timestamptz; workspace_kind text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."teamId" = OLD."teamId" THEN
    IF TG_TABLE_NAME = 'mikka_team_members' THEN RETURN NEW; END IF;
    IF NEW."workspaceId" = OLD."workspaceId" THEN RETURN NEW; END IF;
  END IF;
  SELECT t."workspaceId", t."archivedAt", w.kind INTO target_workspace, archived_at, workspace_kind
    FROM mikka_teams t JOIN mikka_workspaces w ON w.id=t."workspaceId"
    WHERE t.id = NEW."teamId" FOR SHARE OF t;
  IF NOT FOUND THEN RAISE EXCEPTION 'teamNotFound' USING ERRCODE = '23503'; END IF;
  IF workspace_kind = 'personal' THEN RAISE EXCEPTION 'teamPersonalWorkspace' USING ERRCODE = '23514'; END IF;
  IF archived_at IS NOT NULL THEN RAISE EXCEPTION 'teamArchived' USING ERRCODE = '23514'; END IF;
  IF TG_TABLE_NAME <> 'mikka_team_members' THEN
    IF NEW."workspaceId" <> target_workspace THEN
      RAISE EXCEPTION 'workspaceAccessDenied' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS check_active_team_relation ON mikka_team_issues;
CREATE TRIGGER check_active_team_relation BEFORE INSERT OR UPDATE ON mikka_team_issues
  FOR EACH ROW EXECUTE FUNCTION check_active_team_relation();
DROP TRIGGER IF EXISTS check_active_team_relation ON mikka_team_projects;
CREATE TRIGGER check_active_team_relation BEFORE INSERT OR UPDATE ON mikka_team_projects
  FOR EACH ROW EXECUTE FUNCTION check_active_team_relation();
DROP TRIGGER IF EXISTS check_active_team_relation ON mikka_team_members;
CREATE TRIGGER check_active_team_relation BEFORE INSERT OR UPDATE ON mikka_team_members
  FOR EACH ROW EXECUTE FUNCTION check_active_team_relation();
COMMIT;
