-- Existing-task user-selected Mikka team promotion; no external target is inferred.
begin;
create table if not exists team_issue_promotions (
  "requestId" uuid primary key, "ownerId" text not null, "issueId" uuid not null,
  "teamId" uuid not null, "expectedTeamId" uuid, "expectedRevision" integer not null,
  status text not null default 'preparing', "createdAt" timestamptz not null default now(),
  constraint team_issue_promotion_status check (status in ('preparing','complete','stale'))
);
create unique index if not exists team_issue_one_preparing_promotion on team_issue_promotions ("issueId") where status='preparing';
create or replace function require_explicit_workspace_scope() returns trigger
language plpgsql as $$
begin
  if old.scope='personal' and new.scope='workspace' then
    if new."scopeSetBy" is distinct from 'user' or not new."linearSyncBlocked"
       or current_setting('mikka.team_scope_verified',true) is distinct from new.id::text
       or not (
         exists (select 1 from team_issue_create_requests r
                 where r."requestId"::text=current_setting('mikka.team_scope_request',true)
                   and r."issueId"=new.id and r."ownerId"=new."userId" and r.status='preparing'
                   and r."teamId"::text=current_setting('mikka.team_scope_team',true))
         or exists (select 1 from team_issue_promotions p
                    where p."requestId"::text=current_setting('mikka.team_scope_request',true)
                      and p."issueId"=new.id and p."ownerId"=new."userId" and p.status='preparing'
                      and p."expectedRevision"=old.revision and p."teamId"::text=current_setting('mikka.team_scope_team',true))
       ) then
      raise exception 'authorized Mikka team required for workspace scope' using errcode='23514';
    end if;
  end if;
  return new;
end;
$$;
commit;
