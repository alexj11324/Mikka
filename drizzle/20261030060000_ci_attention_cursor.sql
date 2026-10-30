-- target: MIKKA_DATABASE_URL
begin;
set local lock_timeout='5s';
create table if not exists github_ci_attention_cursor (
  id boolean primary key default true check(id),
  "watchId" uuid,
  kind text,
  "leaseId" uuid,
  "leaseUntil" timestamptz
);
commit;
