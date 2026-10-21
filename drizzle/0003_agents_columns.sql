-- Existing deployments created `agents` with the original four columns.
-- `create table if not exists` in 0001 does not add the newer columns, so
-- bring old tables up to the current schema before the app selects them.
-- Applied with: node --env-file=.env.local scripts/apply-sql.mjs drizzle/0003_agents_columns.sql

alter table agents add column if not exists description text not null default '';
alter table agents add column if not exists instructions text not null default '';
alter table agents add column if not exists "deviceId" uuid references devices (id) on delete set null;
alter table agents add column if not exists "createdAt" timestamptz not null default now();
alter table agents add column if not exists "updatedAt" timestamptz not null default now();

create unique index if not exists agents_user_name_key on agents ("userId", lower(name));
create index if not exists agents_device_idx on agents ("deviceId");
