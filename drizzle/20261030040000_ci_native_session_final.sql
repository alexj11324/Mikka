-- target: MIKKA_DATABASE_URL
-- Legacy snapshots lack proof that their native process exited before capture.
begin;
set local lock_timeout = '5s';
alter table ci_native_sessions add column if not exists final boolean not null default false;
create table if not exists ci_native_session_epochs (
  "runId" uuid primary key references agent_runs(id) on delete cascade,
  epoch uuid not null
);
commit;
