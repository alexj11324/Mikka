-- The Coordinator's conversation and its per-person lease and summary.
-- Mirrors coordinatorSessions and coordinatorMessages in lib/db/schema.ts.
-- Applied by scripts/migrate.mjs on production builds.

create table if not exists coordinator_sessions (
  "userId" text primary key,
  "leaseHolder" text,
  "leaseUntil" timestamptz,
  summary text,
  "summaryThrough" integer not null default 0,
  memory text not null default '',
  "updatedAt" timestamptz not null default now()
);

create table if not exists coordinator_messages (
  id uuid primary key,
  "userId" text not null,
  position integer not null,
  message jsonb not null,
  "createdAt" timestamptz not null default now(),
  constraint coordinator_messages_position_key unique ("userId", position)
);
