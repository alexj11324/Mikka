-- One row per call to the decision model (AI Gateway Decisions API), so the
-- month's spend can be capped. Mirrors decisionCalls in lib/db/schema.ts.
-- Applied by scripts/migrate.mjs on production builds.

create table if not exists decision_calls (
  id uuid primary key,
  purpose text not null,
  model text not null,
  "inputTokens" integer not null default 0,
  "costUsd" numeric(12, 8) not null,
  "createdAt" timestamptz not null default now()
);

create index if not exists decision_calls_created_idx on decision_calls ("createdAt");
