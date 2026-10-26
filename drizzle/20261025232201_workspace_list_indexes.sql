-- target: DATABASE_URL
-- Indexes for per-request workspace lookups:
-- - loadWorkspaceContext reads a user's active memberships by "userId" (the key leads with "workspaceId").
-- - accessibleProjects and setProjectIssues read projects by owner "userId".
-- - listProjectEvents reads one project's events newest first.
-- - issueTeamScope reads team task links by "teamId" (the key is "issueId").
-- Mirrors lib/db/workspace-schema.ts, project-schema.ts and team-schema.ts. Safe to run again.
create index if not exists mikka_workspace_members_user_idx on mikka_workspace_members ("userId");
create index if not exists workspace_projects_owner_idx on workspace_projects ("userId");
create index if not exists workspace_project_events_project_created_idx on workspace_project_events ("projectId", "userId", "createdAt" desc);
create index if not exists mikka_team_issues_team_idx on mikka_team_issues ("teamId");
