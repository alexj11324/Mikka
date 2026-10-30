-- target: MIKKA_DATABASE_URL
begin;
set local lock_timeout = '5s';
alter table github_ci_observations add column if not exists "pollLeaseId" uuid;
alter table github_ci_observations add column if not exists "pollLeaseUntil" timestamptz;
alter table github_ci_observations add column if not exists "pollAttempt" integer not null default 0;
alter table github_ci_observations add column if not exists "pollObservation" jsonb;
alter table github_ci_observations add column if not exists "pollTokenEnvelope" bytea;
alter table github_ci_observations add column if not exists "pollTokenExpiresAt" timestamptz;
alter table github_ci_observations add column if not exists "pollRules" jsonb;
create table if not exists github_ci_poll_outbox (
  "userId" text not null,
  "issueId" uuid not null,
  "remoteKey" text not null,
  "prNumber" integer not null,
  head text not null,
  "originRunId" uuid not null,
  "scopeVersion" integer not null,
  generation bigint not null,
  payload jsonb not null,
  "createdAt" timestamptz not null default now(),
  "deliveredAt" timestamptz,
  "leaseId" uuid,
  "leaseUntil" timestamptz,
  attempts integer not null default 0,
  "nextAttemptAt" timestamptz not null default now(),
  primary key ("userId","issueId","remoteKey","prNumber",head),
  foreign key ("userId","issueId","remoteKey","prNumber") references github_ci_observations ("userId","issueId","remoteKey","prNumber") on delete cascade
);
commit;
