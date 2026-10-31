-- #195: verified references only; this table grants no provider write authority.
create table if not exists github_issue_links (
  "issueId" uuid primary key references issues(id) on delete cascade,
  "ownerId" text not null references "user"(id) on delete cascade,
  "remoteKey" text not null, "githubIssueId" text not null,
  number integer not null check (number > 0), url text not null,
  "repositoryId" text not null, "installationId" text not null,
  "githubAccountId" text not null, state text not null check (state in ('open','closed')),
  "githubUpdatedAt" timestamptz not null, "verifiedAt" timestamptz not null default now(),
  unique ("ownerId","githubIssueId")
);
create or replace function preserve_github_issue_link_target() returns trigger language plpgsql as $$
begin
  if row(old."issueId",old."ownerId",old."remoteKey",old."githubIssueId",old.number,old.url,old."repositoryId")
    is distinct from row(new."issueId",new."ownerId",new."remoteKey",new."githubIssueId",new.number,new.url,new."repositoryId") then
    raise exception 'GitHub issue mapping target is immutable' using errcode='23514';
  end if;
  return new;
end;
$$;
drop trigger if exists preserve_github_issue_link_target on github_issue_links;
create trigger preserve_github_issue_link_target before update on github_issue_links
  for each row execute function preserve_github_issue_link_target();
