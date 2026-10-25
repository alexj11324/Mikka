-- MIK-47: who set an issue's scope. The agent judges it once at creation; a
-- person's one-click change wins and becomes an example for the next judgment.
-- Mirrors issues.scopeSetBy / issues.scopeConfidence in lib/db/schema.ts. Safe to re-run.
alter table issues add column if not exists "scopeSetBy" text not null default 'agent';
alter table issues add column if not exists "scopeConfidence" real;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'issues_scope_set_by_check' and conrelid = 'issues'::regclass) then
    alter table issues add constraint issues_scope_set_by_check check ("scopeSetBy" in ('agent', 'user'));
  end if;
end $$;
create index if not exists issues_user_scope_corrections_idx on issues ("userId", "updatedAt" desc) where "scopeSetBy" = 'user';
