-- Bots: what a person chats with in the left column. A bot runs only on Mikka's
-- own harness (AI SDK), never on a coding agent, so it is its own table and not
-- a row in agents (Claude Code / Codex on a device). Each thread (agent_runs
-- row) records the bot that started it.
-- Additive and safe to re-run: new table, nullable columns with no default
-- (catalog-only), FKs added NOT VALID because every existing row is null.
begin;
set local lock_timeout = '5s';

create table if not exists bots (
  id uuid primary key,
  "userId" text not null,
  name text not null,
  -- A bloub colour id (components/nav/bot-avatar.tsx).
  color text not null default 'encre',
  -- A bloub shape id (components/nav/bot-avatar.tsx).
  shape text not null default 'cercle',
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create unique index if not exists bots_user_name_key on bots ("userId", lower(name));

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
