-- A scope-only legacy action has no authenticated Mikka team target. The
-- server sets this transaction-local fence only while holding the selected
-- team's current membership and relation locks in the workspace database.
begin;
-- Preserve legacy links, but mark only proven Linear-origin imports as
-- verified. An old guessed outbound target has no per-task consent evidence.
alter table linear_issue_links add column if not exists "externalTargetVerified" boolean not null default false;
select set_config('mikka.linear_sync_source', 'linear', true);
update linear_issue_links l set "externalTargetVerified"=true
from issues i
where l."issueId"=i.id and l."ownerId"=i."userId" and l."linearIssueId"=i.id::text
  and exists (select 1 from issue_versions v where v."issueId"=i.id and v."userId"=i."userId"
              and v.revision=1 and v.actor_type='system' and v.actor_id='linear');
create or replace function protect_verified_linear_target() returns trigger language plpgsql as $$
begin
  if new."externalTargetVerified" and (tg_op='INSERT' or not old."externalTargetVerified")
     and current_setting('mikka.linear_sync_source',true) is distinct from 'linear' then
    raise exception 'verified Linear target requires an authorized import' using errcode='23514';
  end if;
  return new;
end;
$$;
drop trigger if exists protect_verified_linear_target on linear_issue_links;
create trigger protect_verified_linear_target before insert or update of "externalTargetVerified" on linear_issue_links
  for each row execute function protect_verified_linear_target();
-- Reset the migration-local import marker before normal application writes.
select set_config('mikka.linear_sync_source', '', true);
create or replace function require_explicit_workspace_scope() returns trigger
language plpgsql as $$
begin
  if old.scope = 'personal' and new.scope = 'workspace' then
    if new."scopeSetBy" <> 'user' or not new."linearSyncBlocked"
       or current_setting('mikka.team_scope_verified', true) is distinct from new.id::text
       or not exists (select 1 from team_issue_create_requests r
                      where r."issueId"=new.id and r."ownerId"=new."userId" and r.status='preparing'
                        and r."teamId"::text = current_setting('mikka.team_scope_team', true)) then
      raise exception 'authorized Mikka team required for workspace scope' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;
-- Also fence explicit outbox inserts that bypass issue/document triggers.
-- Updates remain possible so an old unlinked queued claim can become failed
-- and retain its diagnostic without starving unrelated queued work.
create or replace function prevent_blocked_linear_publish() returns trigger language plpgsql as $$
declare
  blocked boolean;
  verified boolean;
begin
  select exists (select 1 from issues where id=new."issueId" and "linearSyncBlocked" for share) into blocked;
  if tg_table_name='linear_sync_outbox' then
    select exists (select 1 from linear_issue_links l join issues i on i.id=l."issueId" and i."userId"=l."ownerId"
                   join linear_team_syncs t on t.id=l."teamSyncId" and t."ownerId"=l."ownerId" and t.active
                   where l."issueId"=new."issueId" and l."externalTargetVerified") into verified;
    if coalesce(blocked,true) or not verified then
      if tg_op='INSERT' then return null; end if;
      if new.status in ('queued','processing') then
        -- A claim made by a still-running older worker must not acquire a
        -- processing token; keep a visible, retained failure instead.
        new.status := 'failed'; new."claimToken" := null;
        new."lastError" := 'No active verified Linear issue link for this task';
      end if;
    end if;
    return new;
  end if;
  if coalesce(blocked,true) then
    raise exception 'task has no authorized Linear target' using errcode='23514';
  end if;
  return new;
end;
$$;
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

  -- A team connection or a pending unlinked publication is not evidence of
  -- a user-verified external destination. Keep legacy failed rows untouched.
  if not exists (select 1 from linear_issue_links l join linear_team_syncs t on t.id=l."teamSyncId" and t."ownerId"=l."ownerId" and t.active where l."issueId" = target_issue_id and l."ownerId" = target_owner_id and l."externalTargetVerified") then
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
-- Preserve old jobs while revoking claims whose target cannot be proven.
-- Old worker processes and already-sent HTTP requests must be drained before
-- deploying this migration; a database update cannot recall a request in flight.
update linear_sync_outbox o set status='failed', "claimToken"=null,
  "lastError"='No active verified Linear issue link for this task', "updatedAt"=now()
where o.status in ('queued','processing') and not exists (
  select 1 from linear_issue_links l
  join issues i on i.id=l."issueId" and i."userId"=l."ownerId"
  join linear_team_syncs t on t.id=l."teamSyncId" and t."ownerId"=l."ownerId" and t.active
  where l."issueId"=o."issueId" and l."externalTargetVerified" and not i."linearSyncBlocked"
);
commit;
