-- target: DATABASE_URL
create index if not exists mikka_workspaces_owner_idx on mikka_workspaces ("userId");
create index if not exists mikka_workspace_members_user_active_idx on mikka_workspace_members ("userId") where status = 'active';
create index if not exists mikka_workspace_invitations_workspace_pending_idx on mikka_workspace_invitations ("workspaceId") where status = 'pending';
create index if not exists workspace_projects_owner_updated_idx on workspace_projects ("userId", "updatedAt" desc);
create index if not exists workspace_project_events_project_created_idx on workspace_project_events ("projectId", "userId", "createdAt" desc);
create index if not exists orvilo_team_members_user_idx on orvilo_team_members ("userId");
create index if not exists orvilo_team_issues_team_idx on orvilo_team_issues ("teamId");
create index if not exists orvilo_team_projects_workspace_idx on orvilo_team_projects ("workspaceId");
create index if not exists orvilo_team_projects_team_idx on orvilo_team_projects ("teamId");
