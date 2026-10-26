-- A scope transition invalidates all work captured in its previous generation,
-- including work that finishes after a personal -> workspace round trip.
begin;
alter table issues add column if not exists "scopeVersion" integer not null default 1;
create or replace function advance_issue_scope_generation() returns trigger
language plpgsql as $$
begin
  new."scopeVersion" := old."scopeVersion" + case when new.scope is distinct from old.scope then 1 else 0 end;
  return new;
end;
$$;
drop trigger if exists advance_issue_scope_generation on issues;
create trigger advance_issue_scope_generation before update of scope, "scopeVersion" on issues
  for each row execute function advance_issue_scope_generation();
commit;
