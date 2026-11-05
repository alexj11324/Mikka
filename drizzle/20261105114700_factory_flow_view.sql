-- target: MIKKA_DATABASE_URL
-- #1276: one acceptance Artifact and one comment per visited public stage.
set local lock_timeout = '5s';
create table if not exists factory_acceptance_artifacts (
  "taskId" uuid primary key references factory_tasks(id) on delete cascade,
  "artifactId" uuid not null unique references artifacts(id) on delete cascade,
  "candidateId" uuid not null,
  -- Historical receipt, like factory_candidates.runId: live run cleanup must
  -- not remove the task's Artifact index or its recorded execution identity.
  "runId" uuid not null,
  sha256 text not null,
  media jsonb not null default '[]'::jsonb check (jsonb_typeof(media)='array' and jsonb_array_length(media)<=40),
  counts jsonb not null default '{}'::jsonb,
  "updatedAt" timestamptz not null default now(),
  foreign key ("taskId","candidateId") references factory_candidates("taskId",id)
);
-- Also repair a local/preview database that applied the earlier draft of this
-- new migration. No historical receipt or Artifact content is deleted.
alter table factory_acceptance_artifacts drop constraint if exists "factory_acceptance_artifacts_runId_fkey";
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
