-- What a person's Coordinator should hear about: a run that ended, or an issue
-- that moved to done. Mirrors coordinatorEvents in lib/db/schema.ts.
-- Applied by scripts/migrate.mjs on production builds.

create table if not exists coordinator_events (
  id uuid primary key,
  "userId" text not null,
  kind text not null,
  "dedupeKey" text not null,
  "issueId" uuid references issues(id) on delete cascade,
  "runId" uuid references agent_runs(id) on delete cascade,
  payload jsonb not null,
  "deliveredAt" timestamptz,
  "createdAt" timestamptz not null default now()
);

create unique index if not exists coordinator_events_dedupe_key on coordinator_events ("dedupeKey");
create index if not exists coordinator_events_pending_idx on coordinator_events ("userId", "deliveredAt", "createdAt");
