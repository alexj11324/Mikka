-- External-tool decisions share the existing agent head and its scope. No
-- permissions are granted by the migration: an absent action resolves to ask.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
alter table agent_kit_heads add column if not exists external_write_permissions jsonb not null default '{}'::jsonb;
alter table agent_kit_heads add column if not exists external_write_policy_version bigint not null default 0;
create or replace function agent_kit_external_write_policy_revision() returns trigger language plpgsql as $$
begin
  if new.external_write_permissions is distinct from old.external_write_permissions then
    new.external_write_policy_version := old.external_write_policy_version + 1;
  elsif new.external_write_policy_version is distinct from old.external_write_policy_version then
    raise exception 'external write policy version is automatic';
  end if;
  if jsonb_typeof(new.external_write_permissions) <> 'object' then
    raise exception 'external write policy must be an object';
  end if;
  return new;
end $$;
drop trigger if exists agent_kit_external_write_policy_revision on agent_kit_heads;
create trigger agent_kit_external_write_policy_revision before update on agent_kit_heads for each row execute function agent_kit_external_write_policy_revision();
commit;
