-- target: DATABASE_URL
-- Upgrade existing workspace databases for multiple workspaces and public teams.
alter table mikka_workspaces add column if not exists slug varchar(64);
create unique index if not exists orvilo_workspaces_slug_unique on mikka_workspaces (slug);

-- Earlier installs used different constraint names before the table rename.
do $$
declare owner_constraint record;
begin
  for owner_constraint in
    select c.conname from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.conrelid = 'mikka_workspaces'::regclass and c.contype = 'u'
      and cardinality(c.conkey) = 1 and a.attname = 'userId'
  loop
    execute format('alter table mikka_workspaces drop constraint %I', owner_constraint.conname);
  end loop;
end $$;

create table if not exists orvilo_teams (
  id uuid primary key,
  "workspaceId" uuid not null,
  "userId" text not null,
  name varchar(100) not null,
  identifier varchar(12) not null,
  description varchar(500) not null default '',
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique ("workspaceId", identifier)
);

create table if not exists orvilo_team_members (
  "teamId" uuid not null,
  "userId" text not null,
  role text not null default 'member',
  "createdAt" timestamptz not null default now(),
  primary key ("teamId", "userId")
);

create table if not exists orvilo_team_issues (
  "issueId" uuid primary key,
  "teamId" uuid not null,
  "workspaceId" uuid not null,
  "userId" text not null,
  "createdAt" timestamptz not null default now()
);

create table if not exists orvilo_team_projects (
  "projectId" uuid not null,
  "teamId" uuid not null,
  "workspaceId" uuid not null,
  "userId" text not null,
  "isPrimary" boolean not null default false,
  primary key ("projectId", "teamId")
);
