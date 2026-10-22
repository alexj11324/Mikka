-- Linear OAuth, durable webhook inbox/outbox, and external issue/comment bindings.
-- Apply to the Orvilo issue database with scripts/apply-sql.mjs.

begin;

create table if not exists linear_oauth_states (
  "stateHash" text primary key,
  "userId" text not null references "user" (id) on delete cascade,
  verifier text not null,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz not null default now()
);

create table if not exists linear_connections (
  "userId" text primary key references "user" (id) on delete cascade,
  "linearUserId" text not null,
  "organizationId" text not null,
  "organizationName" text not null,
  "accessToken" text not null,
  "refreshToken" text not null,
  "expiresAt" timestamptz not null,
  "revokedAt" timestamptz,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create table if not exists linear_team_syncs (
  id uuid primary key,
  "ownerId" text not null references "user" (id) on delete cascade,
  "linearTeamId" text not null unique,
  "linearTeamKey" text not null,
  "linearTeamName" text not null,
  active boolean not null default true,
  "lastError" text,
  "lastErrorAt" timestamptz,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create index if not exists linear_team_syncs_owner_idx on linear_team_syncs ("ownerId", active);
create unique index if not exists linear_team_syncs_one_active_per_owner_key on linear_team_syncs ("ownerId") where active;

create table if not exists linear_issue_links (
  id uuid primary key,
  "issueId" uuid not null unique references issues (id) on delete cascade,
  "ownerId" text not null references "user" (id) on delete cascade,
  "teamSyncId" uuid not null references linear_team_syncs (id) on delete cascade,
  "linearIssueId" text not null unique,
  "linearIdentifier" text not null,
  "syncStatus" text not null default 'synced',
  "lastError" text,
  "appSyncedAt" timestamptz,
  "linearUpdatedAt" timestamptz,
  "remoteRemovedAt" timestamptz,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create index if not exists linear_issue_links_team_idx on linear_issue_links ("teamSyncId");

create table if not exists linear_comment_links (
  id uuid primary key,
  "issueLinkId" uuid not null references linear_issue_links (id) on delete cascade,
  "threadId" text not null,
  "messageId" text not null,
  "linearCommentId" text not null unique,
  "parentLinearCommentId" text,
  "bodyHash" text not null,
  "syncStatus" text not null default 'pending',
  "lastError" text,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique ("threadId", "messageId")
);

create table if not exists linear_sync_outbox (
  id uuid primary key,
  "issueId" uuid not null references issues (id) on delete cascade,
  status text not null default 'queued',
  attempts integer not null default 0,
  "availableAt" timestamptz not null default now(),
  "lastError" text,
  "lastAttemptAt" timestamptz,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create unique index if not exists linear_sync_outbox_open_issue_key
  on linear_sync_outbox ("issueId") where status in ('queued', 'processing');
create index if not exists linear_sync_outbox_ready_idx on linear_sync_outbox (status, "availableAt");

create table if not exists linear_sync_inbox (
  "deliveryId" text primary key,
  "organizationId" text not null,
  "eventType" text not null,
  payload jsonb not null,
  status text not null default 'queued',
  attempts integer not null default 0,
  "availableAt" timestamptz not null default now(),
  "lastError" text,
  "lastAttemptAt" timestamptz,
  "receivedAt" timestamptz not null default now(),
  "processedAt" timestamptz
);
create index if not exists linear_sync_inbox_ready_idx on linear_sync_inbox (status, "availableAt");

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
      or old.content->'attrs'->'orvilo'->'assignee' is distinct from new.content->'attrs'->'orvilo'->'assignee'
      or old.content->'attrs'->'orvilo'->'labels' is distinct from new.content->'attrs'->'orvilo'->'labels'
      or old.content->'attrs'->'orvilo'->'dueDate' is distinct from new.content->'attrs'->'orvilo'->'dueDate'
    ) then
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
    insert into linear_sync_outbox (id, "issueId")
    values (gen_random_uuid(), target_issue_id)
    on conflict ("issueId") where status in ('queued', 'processing')
    do update set "availableAt" = now(), "lastError" = null, "updatedAt" = now();
  end if;
  return new;
end;
$$;

drop trigger if exists linear_issue_sync_outbox on issues;
create trigger linear_issue_sync_outbox after insert or update on issues
for each row execute function enqueue_linear_issue_sync();

drop trigger if exists linear_document_sync_outbox on issue_documents;
create trigger linear_document_sync_outbox after insert or update on issue_documents
for each row execute function enqueue_linear_issue_sync();

commit;
