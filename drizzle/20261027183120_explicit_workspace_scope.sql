-- Older app instances may still finish a model judgment after deployment.
-- They leave scopeSetBy=agent, unlike the explicit user scope action.
begin;
create or replace function require_explicit_workspace_scope() returns trigger
language plpgsql as $$
begin
  if old.scope = 'personal' and new.scope = 'workspace' and new."scopeSetBy" <> 'user' then
    raise exception 'workspace scope requires an explicit user choice' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists require_explicit_workspace_scope on issues;
create trigger require_explicit_workspace_scope before update of scope on issues
  for each row execute function require_explicit_workspace_scope();
commit;
