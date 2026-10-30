-- target: MIKKA_DATABASE_URL
begin;
set local lock_timeout='5s';
create table if not exists github_ci_api_budget (
  id boolean primary key default true check (id),
  "windowStart" timestamptz not null,
  used integer not null check (used>=0),
  "blockedUntil" timestamptz
);
commit;
