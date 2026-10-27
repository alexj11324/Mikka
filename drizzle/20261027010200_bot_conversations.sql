-- Bots run on the Coordinator harness: each bot gets its own conversation,
-- memory and inbox in the Coordinator tables, told apart by "botId" (null is
-- the person's Coordinator). Mirrors coordinatorSessions, coordinatorMessages
-- and coordinatorEvents in lib/db/schema.ts. Nullable columns with no default
-- are catalog-only; the old keys are replaced by the same columns plus
-- "botId" with NULLS NOT DISTINCT, so every existing row keeps its key.
-- Safe to re-run. Applied by scripts/migrate.mjs on production builds.
begin;
set local lock_timeout = '5s';

alter table coordinator_sessions add column if not exists "botId" uuid references bots(id) on delete cascade;
alter table coordinator_messages add column if not exists "botId" uuid references bots(id) on delete cascade;
alter table coordinator_events add column if not exists "botId" uuid references bots(id) on delete cascade;

alter table coordinator_sessions drop constraint if exists coordinator_sessions_pkey;
do $$
declare old record;
begin
  if not exists (select 1 from pg_constraint where conname = 'coordinator_sessions_chat_key') then
    alter table coordinator_sessions add constraint coordinator_sessions_chat_key unique nulls not distinct ("userId", "botId");
  end if;
  -- The old one-chat key on ("userId", position), whatever it is named
  -- (0008 names it coordinator_messages_position_key; schema pushes do not).
  for old in select conname from pg_constraint where conrelid = 'coordinator_messages'::regclass and contype = 'u'
    and conkey = array[(select attnum from pg_attribute where attrelid = 'coordinator_messages'::regclass and attname = 'userId'),
                       (select attnum from pg_attribute where attrelid = 'coordinator_messages'::regclass and attname = 'position')]::int2[] loop
    execute format('alter table coordinator_messages drop constraint %I', old.conname);
  end loop;
  if not exists (select 1 from pg_constraint where conname = 'coordinator_messages_position_key') then
    alter table coordinator_messages add constraint coordinator_messages_position_key unique nulls not distinct ("userId", "botId", position);
  end if;
end $$;

commit;
