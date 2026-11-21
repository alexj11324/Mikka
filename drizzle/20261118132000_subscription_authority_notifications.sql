-- target: MIKKA_DATABASE_URL
-- Revocation events are delivered only after the authorizing write commits.
-- Payloads are scoped opaque row identifiers, never credentials or user text.
begin;
set local lock_timeout = '5s';

create or replace function mikka_notify_subscription_authority_change() returns trigger
language plpgsql as $$
declare
  old_row jsonb;
  new_row jsonb;
begin
  if tg_op <> 'INSERT' then old_row := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then new_row := to_jsonb(new); end if;

  if tg_table_name = 'byos_connections' then
    if tg_op = 'UPDATE' and
      (old_row->'ownerId', old_row->'workspaceId', old_row->'provider', old_row->'state', old_row->'epoch',
       old_row->'credentialVersion', old_row->'quota', old_row->'paused') is not distinct from
      (new_row->'ownerId', new_row->'workspaceId', new_row->'provider', new_row->'state', new_row->'epoch',
       new_row->'credentialVersion', new_row->'quota', new_row->'paused') then
      return null;
    end if;
    if old_row is not null then perform pg_notify('mikka_subscription_authority_v1', 'connection:' || (old_row->>'id')); end if;
    if new_row is not null and (old_row is null or old_row->>'id' is distinct from new_row->>'id') then
      perform pg_notify('mikka_subscription_authority_v1', 'connection:' || (new_row->>'id'));
    end if;
  elsif tg_table_name = 'byos_bindings' then
    if tg_op = 'UPDATE' and old_row is not distinct from new_row then return null; end if;
    if old_row is not null then
      perform pg_notify('mikka_subscription_authority_v1', 'binding:' || (old_row->>'id'));
      perform pg_notify('mikka_subscription_authority_v1', 'connection:' || (old_row->>'connectionId'));
    end if;
    if new_row is not null then
      perform pg_notify('mikka_subscription_authority_v1', 'binding:' || (new_row->>'id'));
      if old_row is null or old_row->>'connectionId' is distinct from new_row->>'connectionId' then
        perform pg_notify('mikka_subscription_authority_v1', 'connection:' || (new_row->>'connectionId'));
      end if;
    end if;
  elsif tg_table_name = 'byos_native_runs' then
    if tg_op = 'UPDATE' and old_row is not distinct from new_row then return null; end if;
    if old_row is not null then
      perform pg_notify('mikka_subscription_authority_v1', 'run:' || (old_row->>'runId'));
      perform pg_notify('mikka_subscription_authority_v1', 'binding:' || (old_row->>'bindingId'));
    end if;
    if new_row is not null then
      perform pg_notify('mikka_subscription_authority_v1', 'run:' || (new_row->>'runId'));
      if old_row is null or old_row->>'bindingId' is distinct from new_row->>'bindingId' then
        perform pg_notify('mikka_subscription_authority_v1', 'binding:' || (new_row->>'bindingId'));
      end if;
    end if;
  elsif tg_table_name = 'agent_runs' then
    if tg_op = 'UPDATE' and
      (old_row->'id', old_row->'userId', old_row->'agentId', old_row->'agentDefinition', old_row->'status', old_row->'leaseExpiresAt', old_row->'stopRequestedAt') is not distinct from
      (new_row->'id', new_row->'userId', new_row->'agentId', new_row->'agentDefinition', new_row->'status', new_row->'leaseExpiresAt', new_row->'stopRequestedAt') then
      return null;
    end if;
    if old_row is not null then perform pg_notify('mikka_subscription_authority_v1', 'run:' || (old_row->>'id')); end if;
    if new_row is not null and (old_row is null or old_row->>'id' is distinct from new_row->>'id') then
      perform pg_notify('mikka_subscription_authority_v1', 'run:' || (new_row->>'id'));
    end if;
  end if;
  return null;
end;
$$;

create trigger subscription_authority_connection_changed
after insert or update of "ownerId", "workspaceId", provider, state, epoch, "credentialVersion", quota, paused or delete on byos_connections
for each row execute function mikka_notify_subscription_authority_change();
create trigger subscription_authority_binding_changed
after insert or update or delete on byos_bindings
for each row execute function mikka_notify_subscription_authority_change();
create trigger subscription_authority_native_run_changed
after insert or update or delete on byos_native_runs
for each row execute function mikka_notify_subscription_authority_change();
create trigger subscription_authority_run_changed
after insert or update of id, "userId", "agentId", "agentDefinition", status, "leaseExpiresAt", "stopRequestedAt" or delete on agent_runs
for each row execute function mikka_notify_subscription_authority_change();

commit;
