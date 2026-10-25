-- A run whose device went offline is queued again as a new run that points
-- back at the one it replaces (lib/run-retry.ts). Mirrors agentRuns in
-- lib/db/schema.ts. Both columns are metadata-only adds; no table rewrite.
-- Applied by scripts/migrate.mjs on production builds.
set local lock_timeout = '5s';
alter table agent_runs add column if not exists attempt integer not null default 1;
alter table agent_runs add column if not exists "retryOf" uuid references agent_runs(id) on delete set null;
