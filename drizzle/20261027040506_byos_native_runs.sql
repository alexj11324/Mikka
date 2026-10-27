-- target: MIKKA_DATABASE_URL
-- Pin a run's explicit subscription selection; reconnect never silently rebinds it.
begin;
set local lock_timeout = '5s';
create table if not exists byos_native_runs (
  "runId" uuid primary key references agent_runs(id) on delete cascade,
  "bindingId" uuid not null references byos_bindings(id)
);
commit;
