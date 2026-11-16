-- target: DATABASE_URL
-- Reference-only repositories are not execution targets or GitHub grants.
CREATE TABLE IF NOT EXISTS workspace_project_dependency_repositories (
  "workspaceId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "githubRepositoryId" text NOT NULL CHECK ("githubRepositoryId" ~ '^[1-9][0-9]*$'),
  PRIMARY KEY ("projectId", "githubRepositoryId"),
  FOREIGN KEY ("projectId", "workspaceId") REFERENCES workspace_projects(id,"workspaceId") ON DELETE CASCADE
);
