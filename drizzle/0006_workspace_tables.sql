-- target: DATABASE_URL
-- Workspace and project tables in the workspace database. Earlier these were
-- created by hand outside the repo, so a fresh database never got them.
-- Mirrors lib/db/workspace-schema.ts and lib/db/project-schema.ts; runs after
-- 0004, so a database that already has the tables is left as it is.
-- Applied by scripts/migrate.mjs on production builds.

create table if not exists mikka_workspaces (
  id uuid primary key,
  "userId" text not null unique,
  name varchar(120) not null,
  "createdAt" timestamptz not null default now()
);

create table if not exists mikka_workspace_members (
  "workspaceId" uuid not null,
  "userId" text not null,
  name text not null,
  email text not null,
  role text not null,
  status text not null default 'active',
  "createdAt" timestamptz not null default now(),
  primary key ("workspaceId", "userId")
);

create table if not exists mikka_workspace_invitations (
  id uuid primary key,
  "workspaceId" uuid not null,
  "userId" text not null,
  email text not null,
  role text not null,
  "tokenHash" text not null unique,
  status text not null default 'pending',
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz not null default now(),
  unique ("workspaceId", email)
);

create table if not exists workspace_projects (
  id uuid primary key,
  "userId" text not null,
  name varchar(200) not null,
  summary varchar(500) not null,
  description text not null,
  status text not null,
  priority text not null,
  lead text not null,
  team varchar(100) not null,
  "startDate" varchar(10) not null,
  "targetDate" varchar(10) not null,
  properties jsonb not null default '{"color":"green","members":[],"labels":[],"dependencyIds":[],"milestones":[]}',
  "issueIds" jsonb not null,
  revision integer not null,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create table if not exists workspace_project_events (
  id uuid primary key,
  "userId" text not null,
  "projectId" uuid not null,
  message text not null,
  "createdAt" timestamptz not null default now()
);
