-- #184: explicit workspace-to-personal requests archive the frozen old target.
-- Ordinary Linear bidirectional sync remains governed by its existing flag.
begin;
alter table linear_sync_outbox add column if not exists operation text not null default 'sync';
alter table linear_sync_outbox add column if not exists "archiveTarget" jsonb;
do $$ begin
  if not exists(select 1 from pg_constraint where conname='linear_outbox_operation_check' and conrelid='linear_sync_outbox'::regclass) then
    alter table linear_sync_outbox add constraint linear_outbox_operation_check check(operation in ('sync','archive'));
  end if;
  if not exists(select 1 from pg_constraint where conname='linear_outbox_archive_target_check' and conrelid='linear_sync_outbox'::regclass) then
    alter table linear_sync_outbox add constraint linear_outbox_archive_target_check check((operation='archive')=("archiveTarget" is not null));
  end if;
end $$;
alter table linear_issue_detachments add column if not exists "externalTargetVerified" boolean not null default false;
alter table linear_issue_detachments add column if not exists "archivedAt" timestamptz;
drop index if exists linear_sync_outbox_open_issue_key;
create unique index linear_sync_outbox_open_issue_key on linear_sync_outbox("issueId") where operation='sync' and status in ('queued','processing');
create unique index if not exists linear_sync_outbox_open_archive_key on linear_sync_outbox("issueId","scopeVersion") where operation='archive' and status in ('queued','processing');

create or replace function preserve_linear_archive_request() returns trigger language plpgsql as $$
begin
  if old.operation is distinct from new.operation or (old.operation='archive' and
    (old."issueId" is distinct from new."issueId" or old."scopeVersion" is distinct from new."scopeVersion" or old."archiveTarget" is distinct from new."archiveTarget")) then
    raise exception 'Linear archive request identity is immutable' using errcode='23514';
  end if;
  return new;
end;
$$;
drop trigger if exists preserve_linear_archive_request on linear_sync_outbox;
create trigger preserve_linear_archive_request before update on linear_sync_outbox for each row execute function preserve_linear_archive_request();

create or replace function prevent_blocked_linear_publish() returns trigger language plpgsql as $$
declare
  blocked boolean;
  verified boolean;
begin
  select exists (select 1 from issues where id=new."issueId" and "linearSyncBlocked" for share) into blocked;
  if tg_table_name='linear_sync_outbox' then
    if new.operation='archive' then
      if tg_op='INSERT' and (current_setting('mikka.personal_scope_request',true) is distinct from new."issueId"::text
        or not exists(select 1 from issues i where i.id=new."issueId" and i.scope='personal' and i."scopeSetBy"='user'
          and i."userId"=new."archiveTarget"->>'ownerId' and i."scopeVersion"=new."scopeVersion"+1)) then
        raise exception 'explicit owner personal-scope request required for Linear archive' using errcode='23514';
      end if;
      -- An older deployed sync worker does not understand archive jobs. It
      -- cannot claim one and silently finish it as an ordinary stale sync.
      if tg_op='UPDATE' and new.status='processing' and
        (old.status is distinct from new.status or old."claimToken" is distinct from new."claimToken") and
        current_setting('mikka.linear_archive_claim',true) is distinct from new.id::text||':'||new."claimToken"::text then
        return null;
      end if;
      return new;
    end if;
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
    where "issueId" = target_issue_id and operation='sync' and status = 'failed';
    insert into linear_sync_outbox (id, "issueId", "scopeVersion")
    values (gen_random_uuid(), target_issue_id, target_scope_version)
    on conflict ("issueId") where operation='sync' and status in ('queued', 'processing')
    do update set "availableAt" = now(), "lastError" = null, "updatedAt" = now();
  end if;
  return new;
end;
$$;

create or replace function detach_personal_issue() returns trigger
language plpgsql as $$
declare archive_target jsonb;
begin
  if new.scope='personal' and old.scope is distinct from new.scope then
    if new."scopeSetBy"='user' and current_setting('mikka.personal_scope_request',true)=new.id::text then
      select jsonb_build_object('ownerId',new."userId",'teamSyncId',l."teamSyncId",'linearTeamId',t."linearTeamId",
        'linearIssueId',l."linearIssueId",'sourceLinkId',l.id,'publicationId',l."publicationId",'organizationId',c."organizationId",
        'targetVerified',l."externalTargetVerified" and l."ownerId"=new."userId" and t."ownerId"=new."userId")
        into archive_target from linear_issue_links l join linear_team_syncs t on t.id=l."teamSyncId"
        left join linear_connections c on c."userId"=new."userId" where l."issueId"=new.id;
      if archive_target is null and (exists(select 1 from linear_issue_publications where "issueId"=new.id and "retiredAt" is null)
        or exists(select 1 from linear_sync_outbox where "issueId"=new.id and operation='sync' and status in ('queued','processing','failed'))) then
        -- Retain an unresolved legacy publication for review. An absent link is
        -- not authority to guess a team or mutate a remote issue.
        archive_target=jsonb_build_object('ownerId',new."userId",'teamSyncId',null,'linearTeamId',null,
          'linearIssueId',new.id::text,'sourceLinkId',null,'publicationId',null,'organizationId',null,'targetVerified',false);
      end if;
    end if;
    insert into linear_issue_detachments("linearIssueId","issueId","ownerId","teamSyncId","linearIdentifier","sourceLinkId","publicationId","externalTargetVerified")
      select "linearIssueId","issueId","ownerId","teamSyncId","linearIdentifier",id,"publicationId","externalTargetVerified"
      from linear_issue_links where "issueId"=new.id
      on conflict ("linearIssueId") do nothing;
    -- Includes a create whose HTTP response has not returned and has no link yet.
    insert into linear_issue_detachments("linearIssueId","issueId","ownerId","teamSyncId","publicationId")
      select "linearIssueId","issueId","ownerId","teamSyncId",id from linear_issue_publications
      where "issueId"=new.id and "retiredAt" is null
      on conflict ("linearIssueId") do update set "publicationId"=coalesce(linear_issue_detachments."publicationId",excluded."publicationId");
    -- Fence the legacy app-UUID identity even if an older create has no response
    -- or reservation. A guard-only row is not proof of a remote issue to archive.
    insert into linear_issue_detachments("linearIssueId","issueId","ownerId")
      values(new.id::text,new.id,new."userId") on conflict ("linearIssueId") do nothing;
    update linear_issue_publications set "retiredAt"=now() where "issueId"=new.id and "retiredAt" is null;
    delete from linear_issue_links where "issueId"=new.id;
    update linear_sync_outbox set status='done',"claimToken"=null,"lastError"=null,"updatedAt"=now()
      where "issueId"=new.id and operation='sync' and status in ('queued','processing','failed');
    if archive_target is not null then
      insert into linear_sync_outbox(id,"issueId","scopeVersion",operation,"archiveTarget")
        values(gen_random_uuid(),new.id,old."scopeVersion",'archive',archive_target);
    end if;
    update run_tokens set "revokedAt"=now() where "revokedAt" is null and "runId" in
      (select id from agent_runs where "issueId"=new.id and "userId"<>new."userId");
    update agent_runs set status='cancelled',"stopRequestedAt"=now(),"finishedAt"=now(),"leaseExpiresAt"=null,
      "stopReason"='Task became personal',"updatedAt"=now()
      where "issueId"=new.id and "userId"<>new."userId" and status in ('queued','preparing','running','waiting_input','finishing');
  end if;
  return new;
end;
$$;
commit;
