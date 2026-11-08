-- target: DATABASE_URL
-- Project tenancy is explicit. Unproved legacy rows stay NULL and inaccessible.
-- Cross-database evidence is reconciled only after both targets are migrated.
ALTER TABLE workspace_projects ADD COLUMN IF NOT EXISTS "workspaceId" uuid REFERENCES mikka_workspaces(id);
ALTER TABLE workspace_projects ADD COLUMN IF NOT EXISTS "leadUserId" text;
CREATE INDEX IF NOT EXISTS workspace_projects_workspace_idx ON workspace_projects("workspaceId");
CREATE UNIQUE INDEX IF NOT EXISTS workspace_projects_id_workspace_unique ON workspace_projects(id,"workspaceId");

CREATE TABLE workspace_project_tasks (
  "issueId" uuid PRIMARY KEY,
  "projectId" uuid NOT NULL,
  "workspaceId" uuid NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_project_tasks_project_fk FOREIGN KEY ("projectId","workspaceId")
    REFERENCES workspace_projects(id,"workspaceId") ON DELETE CASCADE
);
CREATE INDEX workspace_project_tasks_project_idx ON workspace_project_tasks("projectId","issueId");
CREATE INDEX workspace_project_tasks_workspace_idx ON workspace_project_tasks("workspaceId");

CREATE TABLE workspace_project_members (
  "projectId" uuid NOT NULL,
  "workspaceId" uuid NOT NULL,
  "userId" text NOT NULL,
  role text NOT NULL DEFAULT 'member' CHECK (role='member'),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("projectId","userId"),
  CONSTRAINT workspace_project_members_project_fk FOREIGN KEY ("projectId","workspaceId")
    REFERENCES workspace_projects(id,"workspaceId") ON DELETE CASCADE
);
CREATE INDEX workspace_project_members_workspace_user_idx ON workspace_project_members("workspaceId","userId");

-- Historical conflicting Team links remain evidence for repair. This constraint
-- protects all new/changed links without legitimizing those historical rows.
ALTER TABLE mikka_team_projects ADD CONSTRAINT mikka_team_projects_project_workspace_fk
  FOREIGN KEY ("projectId","workspaceId") REFERENCES workspace_projects(id,"workspaceId") ON DELETE CASCADE NOT VALID;

CREATE TABLE workspace_project_repairs (
  "projectId" uuid PRIMARY KEY REFERENCES workspace_projects(id) ON DELETE CASCADE,
  reason text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  "checkedAt" timestamptz NOT NULL DEFAULT now()
);
-- A receipt prevents a later migration retry from restoring an old JSONB link
-- after the user has moved or ungrouped a task through the canonical API.
CREATE TABLE workspace_project_v2_migrations (
  "projectId" uuid PRIMARY KEY REFERENCES workspace_projects(id) ON DELETE CASCADE,
  "completedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION preserve_project_workspace() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD."workspaceId" IS NOT NULL AND NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId" THEN
    RAISE EXCEPTION 'projectWorkspaceTransferDenied' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_project_workspace BEFORE UPDATE OF "workspaceId" ON workspace_projects
FOR EACH ROW EXECUTE FUNCTION preserve_project_workspace();

CREATE FUNCTION record_canonical_project() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."workspaceId" IS NOT NULL THEN
    INSERT INTO workspace_project_v2_migrations("projectId") VALUES(NEW.id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER record_canonical_project AFTER INSERT ON workspace_projects
FOR EACH ROW EXECUTE FUNCTION record_canonical_project();

-- All revocation paths (including account removal and SCIM) clear current
-- collaboration roles in the same Workspace transaction. History is retained.
CREATE FUNCTION release_project_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (OLD.status='active' AND NEW.status<>'active') THEN
    UPDATE workspace_projects p SET "leadUserId"=CASE WHEN p."leadUserId"=OLD."userId" THEN NULL ELSE p."leadUserId" END,
      revision=p.revision+1,"updatedAt"=now()
      WHERE p."workspaceId"=OLD."workspaceId" AND (p."leadUserId"=OLD."userId" OR EXISTS(
        SELECT 1 FROM workspace_project_members m WHERE m."projectId"=p.id AND m."workspaceId"=OLD."workspaceId" AND m."userId"=OLD."userId"));
    DELETE FROM workspace_project_members WHERE "workspaceId"=OLD."workspaceId" AND "userId"=OLD."userId";
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER release_project_member AFTER DELETE OR UPDATE OF status ON mikka_workspace_members
FOR EACH ROW EXECUTE FUNCTION release_project_member();
