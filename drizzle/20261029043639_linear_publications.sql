-- #184: persist the provider identity before IO and retire it on scope change.
-- No archive/unlink provider policy is chosen by this migration.
begin;
create table if not exists linear_issue_publications (
  id uuid primary key,
  "issueId" uuid not null references issues(id) on delete cascade,
  "ownerId" text not null, "teamSyncId" uuid not null,
  "scopeVersion" integer not null, "linearIssueId" text not null unique,
  "writePending" boolean not null default false,
  "createdAt" timestamptz not null default now(), "retiredAt" timestamptz
);
create unique index if not exists linear_issue_publications_scope_key on linear_issue_publications("issueId", "scopeVersion");
create unique index if not exists linear_issue_publications_active_key on linear_issue_publications("issueId") where "retiredAt" is null;
alter table linear_issue_links add column if not exists "publicationId" uuid references linear_issue_publications(id) on delete set null;
alter table linear_issue_detachments alter column "teamSyncId" drop not null;
alter table linear_issue_detachments alter column "linearIdentifier" drop not null;
alter table linear_issue_detachments alter column "sourceLinkId" drop not null;
alter table linear_issue_detachments add column if not exists "publicationId" uuid;
alter table linear_sync_outbox add column if not exists "scopeVersion" integer not null default 1;
alter table linear_sync_outbox add column if not exists "claimToken" uuid;

insert into linear_issue_publications(id,"issueId","ownerId","teamSyncId","scopeVersion","linearIssueId")
  select gen_random_uuid(),l."issueId",l."ownerId",l."teamSyncId",i."scopeVersion",l."linearIssueId"
  from linear_issue_links l join issues i on i.id=l."issueId" where i.scope='workspace'
  on conflict ("issueId","scopeVersion") do nothing;
update linear_issue_links l set "publicationId"=p.id from linear_issue_publications p
  where p."issueId"=l."issueId" and p."linearIssueId"=l."linearIssueId" and p."retiredAt" is null and l."publicationId" is null;
update linear_sync_outbox o set "scopeVersion"=i."scopeVersion" from issues i
  where i.id=o."issueId" and o.status in ('queued','processing');

create or replace function detach_personal_issue() returns trigger
language plpgsql as $$
begin
  if new.scope='personal' and old.scope is distinct from new.scope then
    insert into linear_issue_detachments("linearIssueId","issueId","ownerId","teamSyncId","linearIdentifier","sourceLinkId","publicationId")
      select "linearIssueId","issueId","ownerId","teamSyncId","linearIdentifier",id,"publicationId"
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
      where "issueId"=new.id and status in ('queued','processing','failed');
    update run_tokens set "revokedAt"=now() where "revokedAt" is null and "runId" in
      (select id from agent_runs where "issueId"=new.id and "userId"<>new."userId");
    update agent_runs set status='cancelled',"stopRequestedAt"=now(),"finishedAt"=now(),"leaseExpiresAt"=null,
      "stopReason"='Task became personal',"updatedAt"=now()
      where "issueId"=new.id and "userId"<>new."userId" and status in ('queued','preparing','running','waiting_input','finishing');
  end if;
  return new;
end;
$$;

create or replace function reject_detached_linear_link() returns trigger
language plpgsql as $$
declare target_scope text; target_version integer; target_owner text; publication linear_issue_publications%rowtype;
begin
  select scope,"scopeVersion","userId" into target_scope,target_version,target_owner from issues where id=new."issueId" for share;
  if target_scope<>'workspace' or target_owner<>new."ownerId" or exists(select 1 from linear_issue_detachments where "linearIssueId"=new."linearIssueId") then
    raise exception 'Personal or retired Linear identity cannot be linked' using errcode='23514';
  end if;
  select * into publication from linear_issue_publications where "issueId"=new."issueId" and "scopeVersion"=target_version;
  if not found then
    insert into linear_issue_publications(id,"issueId","ownerId","teamSyncId","scopeVersion","linearIssueId")
      values(coalesce(new."publicationId",gen_random_uuid()),new."issueId",new."ownerId",new."teamSyncId",target_version,new."linearIssueId") returning * into publication;
  end if;
  if publication."retiredAt" is not null or publication."linearIssueId"<>new."linearIssueId" or publication."teamSyncId"<>new."teamSyncId"
     or (new."publicationId" is not null and new."publicationId"<>publication.id) then
    raise exception 'Linear link does not belong to the current publication' using errcode='23514';
  end if;
  new."publicationId"=publication.id;
  return new;
end;
$$;
drop trigger if exists reject_detached_linear_link on linear_issue_links;
create trigger reject_detached_linear_link before insert or update of "linearIssueId","publicationId","issueId","ownerId","teamSyncId" on linear_issue_links for each row execute function reject_detached_linear_link();

create or replace function preserve_linear_publication_identity() returns trigger
language plpgsql as $$
begin
  if tg_op='UPDATE' then
    if old.id<>new.id or old."issueId"<>new."issueId" or old."ownerId"<>new."ownerId" or old."teamSyncId"<>new."teamSyncId"
       or old."scopeVersion"<>new."scopeVersion" or old."linearIssueId"<>new."linearIssueId"
       or (old."retiredAt" is not null and old."retiredAt" is distinct from new."retiredAt") then
      raise exception 'Linear publication identity is immutable' using errcode='23514';
    end if;
  else
    perform 1 from issues where id=new."issueId" and "userId"=new."ownerId" and scope='workspace' and "scopeVersion"=new."scopeVersion" for share;
    if not found or exists(select 1 from linear_issue_detachments where "linearIssueId"=new."linearIssueId") then
      raise exception 'Linear publication is outside its workspace generation' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists preserve_linear_publication_identity on linear_issue_publications;
create trigger preserve_linear_publication_identity before insert or update on linear_issue_publications for each row execute function preserve_linear_publication_identity();
create or replace function enqueue_linear_issue_sync() returns trigger
language plpgsql as $$
declare
  target_issue_id uuid;
  target_owner_id text;
  target_scope text;
  target_scope_version integer;
  target_content jsonb;
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

  select "userId", scope, "scopeVersion", content into target_owner_id, target_scope, target_scope_version, target_content
  from issues where id = target_issue_id;
  target_metadata := coalesce(nullif(target_content->'attrs'->'mikka', 'null'::jsonb), target_content->'attrs'->'orvilo');
  if target_owner_id is null or target_scope is distinct from 'workspace' or target_metadata->>'deletedAt' is not null then
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
