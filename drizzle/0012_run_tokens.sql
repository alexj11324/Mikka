-- Tokens the agent inside a run uses for the MCP worker tools (report, ask,
-- blocked). Mirrors runTokens in lib/db/schema.ts.
-- Applied by scripts/migrate.mjs on production builds.

create table if not exists run_tokens (
  id uuid primary key,
  "runId" uuid not null references agent_runs(id) on delete cascade,
  "userId" text not null,
  "tokenHash" text not null,
  "expiresAt" timestamptz not null,
  "revokedAt" timestamptz,
  "createdAt" timestamptz not null default now()
);

create unique index if not exists run_tokens_hash_key on run_tokens ("tokenHash");
create index if not exists run_tokens_run_idx on run_tokens ("runId");
