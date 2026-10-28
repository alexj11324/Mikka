-- Per-task publication gate for explicit local team creation. No provider target is inferred.
begin;
alter table issues add column if not exists "linearSyncBlocked" boolean not null default false;
create table if not exists team_issue_create_requests (
  "requestId" uuid primary key, "ownerId" text not null, "issueId" uuid not null unique,
  "teamId" uuid not null, fingerprint text not null, status text not null default 'preparing',
  "createdAt" timestamptz not null default now(),
  constraint team_issue_create_status check (status in ('preparing','complete'))
);
create or replace function prevent_blocked_linear_publish() returns trigger language plpgsql as $$
begin
  if exists (select 1 from issues where id=new."issueId" and "linearSyncBlocked" for share) then
    if tg_table_name='linear_sync_outbox' then return null; end if;
    raise exception 'task has no authorized Linear target' using errcode='23514';
  end if;
  return new;
end;
$$;
drop trigger if exists prevent_blocked_linear_outbox on linear_sync_outbox;
create trigger prevent_blocked_linear_outbox before insert or update of "issueId",status on linear_sync_outbox
  for each row execute function prevent_blocked_linear_publish();
drop trigger if exists prevent_blocked_linear_link on linear_issue_links;
create trigger prevent_blocked_linear_link before insert or update of "issueId","linearIssueId" on linear_issue_links
  for each row execute function prevent_blocked_linear_publish();
create or replace function preserve_linear_block() returns trigger language plpgsql as $$
begin
  if old."linearSyncBlocked" and not new."linearSyncBlocked" then
    raise exception 'explicit Linear target association is not available' using errcode='23514';
  end if;
  return new;
end;
$$;
drop trigger if exists preserve_linear_block on issues;
create trigger preserve_linear_block before update of "linearSyncBlocked" on issues for each row execute function preserve_linear_block();
create or replace function enqueue_linear_issue_sync() returns trigger
language plpgsql as $$
declare
  target_issue_id uuid;
  target_owner_id text;
  target_scope text;
  target_scope_version integer;
  target_content jsonb;
  target_blocked boolean;
  target_metadata jsonb;
  old_metadata jsonb;
  new_metadata jsonb;
begin
  if current_setting('mikka.linear_sync_source', true) = 'linear' then
    return new;
  end if;

  if tg_table_name = 'issues' then
    target_issue_id := new.id;
    if tg_op = 'UPDATE' then
      old_metadata := coalesce(nullif(old.content->'attrs'->'mikka', 'null'::jsonb), old.content->'attrs'->'orvilo');
      new_metadata := coalesce(nullif(new.content->'attrs'->'mikka', 'null'::jsonb), new.content->'attrs'->'orvilo');
      if not (
        old.title is distinct from new.title
        or old.status is distinct from new.status
        or old.priority is distinct from new.priority
        or old.scope is distinct from new.scope
        or (old.content - 'attrs') is distinct from (new.content - 'attrs')
        or old_metadata->>'assignee' is distinct from new_metadata->>'assignee'
        or old_metadata->>'labels' is distinct from new_metadata->>'labels'
        or old_metadata->>'dueDate' is distinct from new_metadata->>'dueDate'
        or old_metadata->>'deletedAt' is distinct from new_metadata->>'deletedAt'
      ) then
        -- App-only metadata must not make a clean issue look dirty to the Linear conflict guard.
        update linear_issue_links set "appSyncedAt" = new."updatedAt", "updatedAt" = now()
        where "issueId" = new.id and "appSyncedAt" is not null and "appSyncedAt" >= old."updatedAt";
        return new;
      end if;
    end if;
  else
    target_issue_id := new."issueId";
  end if;

  select "userId", scope, "scopeVersion", content, "linearSyncBlocked" into target_owner_id, target_scope, target_scope_version, target_content, target_blocked
  from issues where id = target_issue_id;
  target_metadata := coalesce(nullif(target_content->'attrs'->'mikka', 'null'::jsonb), target_content->'attrs'->'orvilo');
  if target_owner_id is null or target_blocked or target_scope is distinct from 'workspace' or target_metadata->>'deletedAt' is not null then
    return new;
  end if;

  if exists (select 1 from linear_team_syncs where "ownerId" = target_owner_id and active)
     or exists (
       select 1 from linear_issue_links l
       join linear_team_syncs t on t.id = l."teamSyncId" and t.active
       where l."issueId" = target_issue_id
     ) then
    update linear_sync_outbox set status = 'done', "lastError" = null, "updatedAt" = now()
    where "issueId" = target_issue_id and status = 'failed';
    insert into linear_sync_outbox (id, "issueId", "scopeVersion")
    values (gen_random_uuid(), target_issue_id, target_scope_version)
    on conflict ("issueId") where status in ('queued', 'processing')
    do update set "availableAt" = now(), "lastError" = null, "updatedAt" = now();
  end if;
  return new;
end;
$$;
commit;
