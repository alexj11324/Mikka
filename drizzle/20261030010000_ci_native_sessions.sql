-- target: MIKKA_DATABASE_URL
-- Native session history is encrypted before entering the database.
begin;
set local lock_timeout = '5s';
create table if not exists ci_native_sessions (
  "runId" uuid primary key references agent_runs(id) on delete cascade,
  ciphertext bytea not null,
  "createdAt" timestamptz not null default now(),
  check (octet_length(ciphertext) between 30 and 8388637)
);
commit;
