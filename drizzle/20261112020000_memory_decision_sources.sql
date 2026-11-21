-- #1821: persist only actual applied consolidation answers; no historical backfill.
create table if not exists user_fact_decisions (
  id uuid primary key,
  "userId" text not null,
  "factId" uuid not null references user_facts(id) on delete cascade,
  "sourceFactIds" uuid[] not null check (cardinality("sourceFactIds") between 1 and 20),
  method text not null check (method = 'consolidation_answer'),
  "decisionKey" text not null,
  "decidedAt" timestamptz not null,
  constraint user_fact_decisions_request_unique unique ("userId", "decisionKey")
);
create index if not exists user_fact_decisions_fact_idx on user_fact_decisions ("userId", "factId");
