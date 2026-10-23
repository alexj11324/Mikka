-- Agent roles (Coordinator, Worker, Reviewer, custom) with auto placement,
-- reasoning effort and an avatar (icon and colour).
-- An agent's device, harness and model may each be null, meaning auto: the
-- server resolves them when a run is queued and stores the result on the run.
-- Applied by scripts/migrate.mjs on production builds.

alter table agents add column if not exists role text not null default 'custom';
alter table agents add column if not exists model text;
alter table agents add column if not exists effort text;
alter table agents add column if not exists icon text;
alter table agents add column if not exists color text;
alter table agents alter column harness drop not null;

create unique index if not exists agents_user_role_key on agents ("userId", role) where role <> 'custom';

alter table agent_runs add column if not exists harness text;
alter table agent_runs add column if not exists model text;
alter table agent_runs add column if not exists effort text;

-- Runs queued before this migration ran on their agent's harness.
update agent_runs set harness = agents.harness
  from agents where agents.id = agent_runs."agentId" and agent_runs.harness is null;
