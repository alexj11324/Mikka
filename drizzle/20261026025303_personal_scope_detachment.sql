-- #184: local privacy boundary shared by archive and unlink semantics.
-- Remote disposition deliberately lives outside this transaction. Keep the
-- remote identity after dropping its active mapping to reject delayed imports.
begin;

create table if not exists linear_issue_detachments (
  "linearIssueId" text primary key,
  "issueId" uuid not null,
  "ownerId" text not null,
  "teamSyncId" uuid not null,
  "linearIdentifier" text not null,
  "sourceLinkId" uuid not null unique,
  "detachedAt" timestamptz not null default now()
);
create index if not exists linear_issue_detachments_issue_idx on linear_issue_detachments ("issueId");

create or replace function detach_personal_issue() returns trigger
language plpgsql as $$
begin
  if new.scope = 'personal' and old.scope is distinct from new.scope then
    insert into linear_issue_detachments ("linearIssueId", "issueId", "ownerId", "teamSyncId", "linearIdentifier", "sourceLinkId")
      select "linearIssueId", "issueId", "ownerId", "teamSyncId", "linearIdentifier", id
      from linear_issue_links where "issueId" = new.id
      on conflict ("linearIssueId") do nothing;
    -- Comment mappings are bookkeeping; the discussion/history in Mikka and
    -- Linear stays intact. The link FK removes only active sync mappings.
    delete from linear_issue_links where "issueId" = new.id;
    update linear_sync_outbox set status = 'done', "lastError" = null, "updatedAt" = now()
      where "issueId" = new.id and status in ('queued', 'processing', 'failed');
    update run_tokens set "revokedAt" = now() where "revokedAt" is null and "runId" in (
      select id from agent_runs where "issueId" = new.id and "userId" <> new."userId"
    );
    update agent_runs set status = 'cancelled', "stopRequestedAt" = now(), "finishedAt" = now(),
      "leaseExpiresAt" = null, "stopReason" = 'Task became personal', "updatedAt" = now()
      where "issueId" = new.id and "userId" <> new."userId"
        and status in ('queued', 'preparing', 'running', 'waiting_input', 'finishing');
  end if;
  return new;
end;
$$;
drop trigger if exists detach_personal_issue on issues;
create trigger detach_personal_issue after update of scope on issues for each row execute function detach_personal_issue();

create or replace function reject_detached_linear_link() returns trigger
language plpgsql as $$
declare target_scope text;
begin
  select scope into target_scope from issues where id = new."issueId" for share;
  if target_scope = 'personal' then
    raise exception 'Personal task cannot acquire a Linear link' using errcode = '23514';
  end if;
  if exists (select 1 from linear_issue_detachments where "linearIssueId" = new."linearIssueId") then
    raise exception 'Detached Linear identity cannot be linked again' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists reject_detached_linear_link on linear_issue_links;
create trigger reject_detached_linear_link before insert or update of "linearIssueId" on linear_issue_links
  for each row execute function reject_detached_linear_link();

-- Serialize queue/claim/retry with scope changes, including a queue operation
-- that passed an application access check just before the scope transaction.
create or replace function require_run_issue_scope() returns trigger
language plpgsql as $$
declare target_owner text; target_scope text;
begin
  if new."issueId" is not null then
    select "userId", scope into target_owner, target_scope from issues where id = new."issueId" for share;
    if target_scope = 'personal' and target_owner <> new."userId"
       and not (pg_trigger_depth() > 1 and new.status = 'cancelled') then
      raise exception 'Personal task is unavailable to this run' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists require_run_issue_scope on agent_runs;
create trigger require_run_issue_scope before insert or update on agent_runs
  for each row execute function require_run_issue_scope();

-- Claims can race token issuance and a daemon can already have passed its
-- request-level check. Fence those writes on the task row as well.
create or replace function require_run_child_issue_scope() returns trigger
language plpgsql as $$
declare target_owner text; target_scope text; run_owner text;
begin
  select i."userId", i.scope, r."userId" into target_owner, target_scope, run_owner
    from issues i join agent_runs r on r."issueId" = i.id
    where r.id = new."runId" for share of i;
  if target_scope = 'personal' and target_owner <> run_owner then
    raise exception 'Personal task is unavailable to this run' using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists require_run_child_issue_scope on run_tokens;
-- Only issuance is fenced here; the scope transaction must still revoke tokens.
create trigger require_run_child_issue_scope before insert on run_tokens for each row execute function require_run_child_issue_scope();
drop trigger if exists require_run_child_issue_scope on run_chunks;
create trigger require_run_child_issue_scope before insert or update on run_chunks for each row execute function require_run_child_issue_scope();
drop trigger if exists require_run_child_issue_scope on run_messages;
create trigger require_run_child_issue_scope before insert or update on run_messages for each row execute function require_run_child_issue_scope();
drop trigger if exists require_run_child_issue_scope on run_checkpoints;
create trigger require_run_child_issue_scope before insert or update on run_checkpoints for each row execute function require_run_child_issue_scope();

commit;
