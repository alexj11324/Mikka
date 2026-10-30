-- target: MIKKA_DATABASE_URL
-- One claimed continuation for each task-bound PR commit, including when a
-- later push returns the PR to an earlier commit.
begin;
set local lock_timeout = '5s';
create table if not exists github_ci_commit_claims (
  "userId" text not null references "user"(id) on delete cascade,
  "issueId" uuid not null references issues(id) on delete cascade,
  "remoteKey" text not null,
  "prNumber" integer not null,
  head text not null check (head ~ '^[a-f0-9]{40}$'),
  "runId" uuid not null references agent_runs(id) on delete cascade,
  "claimedAt" timestamptz not null default now(),
  primary key ("userId", "issueId", "remoteKey", "prNumber", head)
);
commit;
