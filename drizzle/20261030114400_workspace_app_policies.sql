-- target: MIKKA_DATABASE_URL
-- Settings › 团队权限 › 允许使用的应用 (N4). Per workspace, whether its bots may
-- use a connected app (read and write tools alike). No row means 允许, today's
-- behaviour. Enforced where a bot's tools run (workflows/coordinator/steps.ts:
-- composioAction, proposeAccountAction, personalWrite) via lib/app-policy/store.ts.
-- "workspaceId" has no FK: workspaces live in DATABASE_URL.
-- Rollback: DROP TABLE IF EXISTS workspace_app_policies; DELETE FROM schema_migrations WHERE name = '20261030114400_workspace_app_policies.sql';
create table if not exists workspace_app_policies (
  "workspaceId" uuid not null,
  app text not null check (app in ('gmail', 'googlecalendar', 'slack', 'notion')),
  access text not null check (access in ('allow', 'deny')),
  "updatedBy" text not null check (char_length("updatedBy") between 1 and 200),
  "updatedAt" timestamptz not null default now(),
  primary key ("workspaceId", app)
);
