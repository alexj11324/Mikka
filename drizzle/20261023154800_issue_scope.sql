-- MIK-46: every issue is either a workspace issue (two-way synced with Linear,
-- shown by its Linear identifier) or a personal issue (stays in Mikka, shown as
-- PREFIX-number). Personal issues are never written to Linear.
-- Mirrors issues.scope and issuePrefixes in lib/db/schema.ts. Safe to re-run.
begin;

alter table issues add column if not exists scope text not null default 'personal';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'issues_scope_check' and conrelid = 'issues'::regclass) then
    alter table issues add constraint issues_scope_check check (scope in ('workspace', 'personal'));
  end if;
end $$;

-- Issues already in Linear are workspace issues; everything else starts personal,
-- because a personal issue can still move to Linear later and a Linear one cannot come back.
update issues set scope = 'workspace'
where scope <> 'workspace' and id in (select "issueId" from linear_issue_links);

-- The personal prefix a person chose; without a row it comes from their email.
create table if not exists issue_prefixes (
  "userId" text primary key references "user" (id) on delete cascade,
  prefix varchar(4) not null,
  "updatedAt" timestamptz not null default now()
);

-- Same as 0008, plus: only workspace issues reach the Linear outbox, and moving
-- an issue into the workspace queues it.
create or replace function enqueue_linear_issue_sync() returns trigger
language plpgsql as $$
declare
  target_issue_id uuid;
  target_owner_id text;
  target_scope text;
  target_content jsonb;
  target_metadata jsonb;
  old_metadata jsonb;
  new_metadata jsonb;
begin
  if current_setting('orvilo.linear_sync_source', true) = 'linear' then
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

  select "userId", scope, content into target_owner_id, target_scope, target_content
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
    insert into linear_sync_outbox (id, "issueId")
    values (gen_random_uuid(), target_issue_id)
    on conflict ("issueId") where status in ('queued', 'processing')
    do update set "availableAt" = now(), "lastError" = null, "updatedAt" = now();
  end if;
  return new;
end;
$$;

commit;
