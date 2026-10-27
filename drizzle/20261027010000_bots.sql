-- Bots: what a person chats with in the left column; the Coordinator is the
-- built-in one and has no row. A bot is an identity, never a worker agent or
-- a run: it chats on the Coordinator harness and its threads (agent_runs)
-- record it in "botId".
-- The identity ("ownerId", "workspaceId", unique (id, "workspaceId",
-- "ownerId")) is the one the cloud computer (#317, bot_desktops) keys on.
-- Either migration may run first: the table is created with the shared
-- identity and every column the other side adds is added if missing.
-- Additive and safe to re-run; FKs on existing tables are NOT VALID because
-- every existing row is null.
begin;
set local lock_timeout = '5s';

create table if not exists bots (
  id uuid primary key,
  "workspaceId" uuid not null,
  "ownerId" text not null references "user"(id) on delete cascade,
  name text not null,
  "createdAt" timestamptz not null default now(),
  unique (id, "workspaceId", "ownerId")
);
-- A bloub colour and shape id (components/nav/bot-avatar.tsx).
alter table bots add column if not exists color text not null default 'encre';
alter table bots add column if not exists shape text not null default 'cercle';
alter table bots add column if not exists "updatedAt" timestamptz not null default now();
create index if not exists bots_owner_workspace_idx on bots ("ownerId", "workspaceId");
create unique index if not exists bots_owner_workspace_name_key on bots ("ownerId", "workspaceId", lower(name));

alter table agent_runs add column if not exists "botId" uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agent_runs_bot_fk' and conrelid = 'agent_runs'::regclass) then
    alter table agent_runs add constraint agent_runs_bot_fk
      foreign key ("botId") references bots (id) on delete set null not valid;
  end if;
end $$;
create index if not exists agent_runs_bot_created_idx
  on agent_runs ("botId", "createdAt" desc) where "botId" is not null;

commit;
