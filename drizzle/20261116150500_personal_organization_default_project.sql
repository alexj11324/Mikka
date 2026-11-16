-- target: DATABASE_URL
ALTER TABLE mikka_organization_member_project_defaults
  ADD COLUMN "defaultProjectId" uuid REFERENCES workspace_projects(id) ON DELETE SET NULL,
  ADD COLUMN "selectionRevision" integer NOT NULL DEFAULT 0;
