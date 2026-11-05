-- target: MIKKA_DATABASE_URL
-- #1276: one acceptance Artifact and one comment per visited public stage.
set local lock_timeout = '5s';
create table if not exists factory_acceptance_artifacts (
  "taskId" uuid primary key references factory_tasks(id) on delete cascade,
  "artifactId" uuid not null unique references artifacts(id) on delete cascade,
  "candidateId" uuid not null,
  "runId" uuid not null references agent_runs(id),
  sha256 text not null,
  media jsonb not null default '[]'::jsonb check (jsonb_typeof(media)='array' and jsonb_array_length(media)<=40),
  counts jsonb not null default '{}'::jsonb,
  "updatedAt" timestamptz not null default now(),
  foreign key ("taskId","candidateId") references factory_candidates("taskId",id)
);
create table if not exists factory_stage_updates (
  "taskId" uuid not null references factory_tasks(id) on delete cascade,
  stage text not null check (stage in ('triage','spec','implement','review','handoff','completed','cancelled')),
  "commentId" uuid not null,
  "bodyHash" text not null,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  primary key ("taskId",stage)
);
create table if not exists factory_spec_approvals (
  "taskId" uuid not null references factory_tasks(id) on delete cascade,
  "attemptId" uuid primary key references factory_attempts(id),
  "sourceEventId" uuid not null,
  "eventId" uuid not null,
  "userId" text not null,
  "sessionDigest" text not null,
  revision integer not null,
  result jsonb,
  "createdAt" timestamptz not null default now(),
  unique ("taskId","eventId")
);
