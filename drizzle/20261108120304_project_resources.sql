-- target: DATABASE_URL
-- Project settings are tenant configuration, not credentials or running machines.
CREATE TABLE IF NOT EXISTS workspace_repository_policies (
  "workspaceId" uuid PRIMARY KEY REFERENCES mikka_workspaces(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'inherit' CHECK (mode IN ('inherit','restricted')),
  "repositoryKeys" jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof("repositoryKeys")='array'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  "updatedBy" text NOT NULL, "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workspace_environments (
  id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES mikka_workspaces(id) ON DELETE CASCADE,
  name text NOT NULL, configuration jsonb NOT NULL CHECK (jsonb_typeof(configuration)='object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0), "archivedAt" timestamptz,
  "createdBy" text NOT NULL, "updatedBy" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,"workspaceId")
);
CREATE INDEX IF NOT EXISTS workspace_environments_workspace_idx ON workspace_environments("workspaceId", "archivedAt");
CREATE UNIQUE INDEX IF NOT EXISTS workspace_projects_id_workspace_resources_key ON workspace_projects(id,"workspaceId");
CREATE TABLE IF NOT EXISTS workspace_project_environments (
  "projectId" uuid NOT NULL, "workspaceId" uuid NOT NULL, "environmentId" uuid NOT NULL,
  "isDefault" boolean NOT NULL DEFAULT false,
  PRIMARY KEY("projectId","environmentId"),
  FOREIGN KEY("projectId","workspaceId") REFERENCES workspace_projects(id,"workspaceId") ON DELETE CASCADE,
  FOREIGN KEY("environmentId","workspaceId") REFERENCES workspace_environments(id,"workspaceId") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_project_environment_default_key ON workspace_project_environments("projectId") WHERE "isDefault";
CREATE TABLE IF NOT EXISTS workspace_project_repositories (
  "projectId" uuid NOT NULL, "workspaceId" uuid NOT NULL, "repositoryKey" text NOT NULL,
  "baseBranch" text, "environmentId" uuid, "isPrimary" boolean NOT NULL DEFAULT false,
  PRIMARY KEY("projectId","repositoryKey"),
  FOREIGN KEY("projectId","workspaceId") REFERENCES workspace_projects(id,"workspaceId") ON DELETE CASCADE,
  FOREIGN KEY("environmentId","workspaceId") REFERENCES workspace_environments(id,"workspaceId") ON DELETE RESTRICT,
  FOREIGN KEY("projectId","environmentId") REFERENCES workspace_project_environments("projectId","environmentId") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_project_repository_primary_key ON workspace_project_repositories("projectId") WHERE "isPrimary";
CREATE TABLE IF NOT EXISTS workspace_resource_events (
  id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES mikka_workspaces(id) ON DELETE CASCADE,
  "actorId" text NOT NULL, kind text NOT NULL, "resourceId" uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb, "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspace_resource_events_workspace_idx ON workspace_resource_events("workspaceId","createdAt");
