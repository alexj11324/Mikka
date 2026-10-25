-- The latest work in progress of each run, saved by the daemon so another
-- machine can take the run over when its own goes offline (lib/run-leases.ts).
-- The patch is a gzipped `git diff --binary` against baseCommit.
-- Mirrors runCheckpoints in lib/db/schema.ts. New table only.
-- Applied by scripts/migrate.mjs on production builds.
create table if not exists run_checkpoints (
  "runId" uuid primary key references agent_runs(id) on delete cascade,
  "userId" text not null,
  "baseCommit" text not null,
  patch bytea not null,
  files integer not null,
  "takenAt" timestamptz not null,
  "updatedAt" timestamptz not null default now()
);
