-- target: DATABASE_URL
begin;
set local lock_timeout = '5s';
-- Snapshot only once, in the database that actually owns workspaces.
do $$ begin
  if to_regclass('hosted_legacy_workspaces') is null then
    create table hosted_legacy_workspaces ("workspaceId" uuid primary key);
    insert into hosted_legacy_workspaces select id from mikka_workspaces;
  end if;
end $$;
commit;
