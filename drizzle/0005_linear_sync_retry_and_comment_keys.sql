-- Keep comment IDs unique per issue and requeue restored/edited sync work.
-- Applied with: node --env-file=.env.local scripts/apply-sql.mjs drizzle/0005_linear_sync_retry_and_comment_keys.sql

begin;

alter table linear_comment_links drop constraint if exists "linear_comment_links_threadId_messageId_key";
create unique index if not exists linear_comment_links_local_key
  on linear_comment_links ("issueLinkId", "threadId", "messageId");

create or replace function enqueue_linear_issue_sync() returns trigger
language plpgsql as $$
declare
  target_issue_id uuid;
  target_owner_id text;
  target_content jsonb;
begin
  if current_setting('orvilo.linear_sync_source', true) = 'linear' then
    return new;
  end if;

  if tg_table_name = 'issues' then
    target_issue_id := new.id;
    if tg_op = 'UPDATE' and not (
      old.title is distinct from new.title
      or old.status is distinct from new.status
      or old.priority is distinct from new.priority
      or (old.content - 'attrs') is distinct from (new.content - 'attrs')
      or old.content->'attrs'->'orvilo'->>'assignee' is distinct from new.content->'attrs'->'orvilo'->>'assignee'
      or old.content->'attrs'->'orvilo'->>'labels' is distinct from new.content->'attrs'->'orvilo'->>'labels'
      or old.content->'attrs'->'orvilo'->>'dueDate' is distinct from new.content->'attrs'->'orvilo'->>'dueDate'
      or old.content->'attrs'->'orvilo'->>'deletedAt' is distinct from new.content->'attrs'->'orvilo'->>'deletedAt'
    ) then
      -- App-only metadata must not make a clean issue look dirty to the Linear conflict guard.
      update linear_issue_links set "appSyncedAt" = new."updatedAt", "updatedAt" = now()
      where "issueId" = new.id and "appSyncedAt" is not null and "appSyncedAt" >= old."updatedAt";
      return new;
    end if;
  else
    target_issue_id := new."issueId";
  end if;

  select "userId", content into target_owner_id, target_content
  from issues where id = target_issue_id;
  if target_owner_id is null or target_content->'attrs'->'orvilo'->>'deletedAt' is not null then
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
