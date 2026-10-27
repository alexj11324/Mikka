-- Agent definitions are immutable assets; heads, executions and approval state are runtime data.
-- Additive and rerunnable. No historical run is claimed to have a definition snapshot.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table if not exists agent_kit_heads (
  owner_id text not null references "user"(id) on delete cascade,
  bot_key text not null,
  bot_id uuid,
  workspace_id uuid,
  active_version uuid,
  next_version integer not null default 1 check (next_version > 0),
  primary key (owner_id, bot_key),
  foreign key (bot_id, workspace_id, owner_id) references bots(id, "workspaceId", "ownerId") on delete cascade,
  check (bot_key = coalesce(bot_id::text, 'coordinator')),
  check ((bot_id is null and workspace_id is null) or (bot_id is not null and workspace_id is not null))
);
create table if not exists agent_kit_versions (
  id uuid primary key,
  owner_id text not null,
  bot_key text not null,
  version integer not null check (version > 0),
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  source text not null check (source in ('builtin', 'user', 'improvement')),
  request_key text not null,
  base_version uuid,
  created_at timestamptz not null default now(),
  foreign key (owner_id, bot_key) references agent_kit_heads(owner_id, bot_key) on delete cascade,
  unique (owner_id, bot_key, id),
  unique (owner_id, bot_key, version),
  unique (owner_id, bot_key, request_key),
  foreign key (owner_id, bot_key, base_version) references agent_kit_versions(owner_id, bot_key, id)
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'agent_kit_active_version_fk') then
    alter table agent_kit_heads add constraint agent_kit_active_version_fk foreign key (owner_id, bot_key, active_version) references agent_kit_versions(owner_id, bot_key, id) deferrable initially deferred;
  end if;
end $$;
create table if not exists agent_kit_executions (
  id uuid primary key,
  owner_id text not null,
  bot_key text not null,
  execution_key text not null check (length(execution_key) between 1 and 240),
  version_id uuid not null,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (owner_id, bot_key, id),
  unique (owner_id, bot_key, execution_key),
  foreign key (owner_id, bot_key, version_id) references agent_kit_versions(owner_id, bot_key, id) on delete cascade
);
create table if not exists agent_kit_events (
  execution_id uuid not null,
  owner_id text not null,
  bot_key text not null,
  event_key text not null check (length(event_key) between 1 and 240),
  kind text not null check (kind in ('tool_started', 'tool_finished', 'run_finished', 'failure_case')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  primary key (execution_id, event_key),
  foreign key (owner_id, bot_key, execution_id) references agent_kit_executions(owner_id, bot_key, id) on delete cascade
);
create index if not exists agent_kit_events_scope_idx on agent_kit_events(owner_id, bot_key, kind, created_at desc);
create table if not exists agent_kit_proposals (
  id uuid primary key,
  owner_id text not null,
  bot_key text not null,
  baseline_id uuid not null,
  candidate_id uuid not null,
  request_key text not null,
  evidence jsonb not null check (jsonb_typeof(evidence) = 'array'),
  rationale text not null,
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (owner_id, bot_key, id),
  unique (owner_id, bot_key, request_key),
  foreign key (owner_id, bot_key, baseline_id) references agent_kit_versions(owner_id, bot_key, id) on delete cascade,
  foreign key (owner_id, bot_key, candidate_id) references agent_kit_versions(owner_id, bot_key, id) on delete cascade
);
create table if not exists agent_kit_evaluations (
  id uuid primary key,
  owner_id text not null,
  bot_key text not null,
  proposal_id uuid not null,
  request_key text not null,
  mode text not null check (mode in ('fixture', 'live')),
  model text,
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  reports jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (owner_id, bot_key, id),
  unique (owner_id, bot_key, request_key),
  foreign key (owner_id, bot_key, proposal_id) references agent_kit_proposals(owner_id, bot_key, id) on delete cascade
);
create table if not exists agent_kit_activations (
  id uuid primary key,
  owner_id text not null,
  bot_key text not null,
  from_version uuid not null,
  to_version uuid not null,
  request_key text not null,
  reason text not null check (reason in ('edit', 'rollback', 'approved_improvement')),
  created_at timestamptz not null default now(),
  unique (owner_id, bot_key, request_key),
  foreign key (owner_id, bot_key, from_version) references agent_kit_versions(owner_id, bot_key, id) on delete cascade,
  foreign key (owner_id, bot_key, to_version) references agent_kit_versions(owner_id, bot_key, id) on delete cascade
);

create or replace function agent_kit_immutable_row() returns trigger language plpgsql as $$
begin raise exception 'agentKitImmutableRecord' using errcode = '23514'; end $$;
drop trigger if exists agent_kit_versions_immutable on agent_kit_versions;
create trigger agent_kit_versions_immutable before update on agent_kit_versions for each row execute function agent_kit_immutable_row();
drop trigger if exists agent_kit_events_immutable on agent_kit_events;
create trigger agent_kit_events_immutable before update on agent_kit_events for each row execute function agent_kit_immutable_row();
drop trigger if exists agent_kit_activations_immutable on agent_kit_activations;
create trigger agent_kit_activations_immutable before update on agent_kit_activations for each row execute function agent_kit_immutable_row();

create or replace function agent_kit_snapshot_guard() returns trigger language plpgsql as $$
begin
  if new.snapshot is distinct from old.snapshot or new.version_id <> old.version_id or new.owner_id <> old.owner_id or new.bot_key <> old.bot_key or new.execution_key <> old.execution_key then
    raise exception 'agentKitImmutableSnapshot' using errcode = '23514';
  end if;
  if old.status <> 'running' and new is distinct from old then raise exception 'agentKitTerminalExecution' using errcode = '23514'; end if;
  return new;
end $$;
drop trigger if exists agent_kit_execution_guard on agent_kit_executions;
create trigger agent_kit_execution_guard before update on agent_kit_executions for each row execute function agent_kit_snapshot_guard();

alter table agent_runs add column if not exists "agentDefinition" jsonb;
commit;
