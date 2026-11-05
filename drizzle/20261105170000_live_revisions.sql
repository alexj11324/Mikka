-- target: MIKKA_DATABASE_URL
-- A live key's revision: one counter per (kind, id), raised after each
-- committed change is known and before its push is sent. It holds no content.
begin;
set local lock_timeout = '5s';

create table if not exists live_revisions (
  kind text not null,
  id uuid not null,
  revision bigint not null default 1,
  primary key (kind, id)
);

commit;
