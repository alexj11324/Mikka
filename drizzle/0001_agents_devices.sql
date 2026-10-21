-- Devices, agents and runs (Orvilo3). The daemon owns detection and
-- execution; these tables store what it registers and reports.
-- Applied with: node --env-file=.env.local scripts/apply-sql.mjs drizzle/0001_agents_devices.sql

create table if not exists devices (
  id uuid primary key,
  "ownerId" text not null,
  name text not null,
  hostname text,
  platform text,
  arch text,
  "daemonVersion" text,
  "protocolVersion" integer,
  harnesses jsonb not null default '[]'::jsonb,
  "maxConcurrentRuns" integer not null default 3,
  "lastSeenAt" timestamptz,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create index if not exists devices_owner_idx on devices ("ownerId");

create table if not exists device_tokens (
  id uuid primary key,
  "userId" text not null,
  name text not null default '',
  "tokenHash" text not null,
  "lastUsedAt" timestamptz,
  "revokedAt" timestamptz,
  "createdAt" timestamptz not null default now()
);
create unique index if not exists device_tokens_hash_key on device_tokens ("tokenHash");
create index if not exists device_tokens_user_idx on device_tokens ("userId");

create table if not exists device_repos (
  id uuid primary key,
  "deviceId" uuid not null references devices (id) on delete cascade,
  "userId" text not null,
  "repoPath" text not null,
  "remoteUrl" text,
  "baseBranch" text not null default 'main',
  "verifyCommand" text,
  "createdAt" timestamptz not null default now()
);
create unique index if not exists device_repos_key on device_repos ("deviceId", "repoPath");

create table if not exists agents (
  id uuid primary key,
  "userId" text not null,
  harness text not null,
  name text not null,
  description text not null default '',
  instructions text not null default '',
  "deviceId" uuid references devices (id) on delete set null,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create unique index if not exists agents_user_name_key on agents ("userId", lower(name));
create index if not exists agents_device_idx on agents ("deviceId");

create table if not exists agent_runs (
  id uuid primary key,
  "userId" text not null,
  "issueId" uuid references issues (id) on delete cascade,
  "agentId" uuid not null references agents (id) on delete cascade,
  "deviceId" uuid references devices (id) on delete set null,
  "deviceRepoId" uuid references device_repos (id) on delete set null,
  status text not null default 'queued',
  kind text not null default 'implement',
  prompt text not null default '',
  "baseBranch" text not null default 'main',
  "sessionId" text,
  "worktreePath" text,
  "stopReason" text,
  error text,
  report jsonb,
  "leaseExpiresAt" timestamptz,
  "stopRequestedAt" timestamptz,
  "startedAt" timestamptz,
  "finishedAt" timestamptz,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create index if not exists agent_runs_device_status_idx on agent_runs ("deviceId", status);
create index if not exists agent_runs_issue_idx on agent_runs ("issueId", "createdAt");

create table if not exists run_chunks (
  id uuid primary key,
  "runId" uuid not null references agent_runs (id) on delete cascade,
  seq integer not null,
  chunk jsonb not null,
  "createdAt" timestamptz not null default now()
);
create unique index if not exists run_chunks_run_seq_key on run_chunks ("runId", seq);

create table if not exists run_messages (
  id uuid primary key,
  "runId" uuid not null references agent_runs (id) on delete cascade,
  "userId" text not null,
  text text not null,
  "deliveredAt" timestamptz,
  "createdAt" timestamptz not null default now()
);
create index if not exists run_messages_run_idx on run_messages ("runId", "createdAt");
