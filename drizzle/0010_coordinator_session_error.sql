-- Why the Coordinator's last turn failed, so the chat can say so.
-- Mirrors coordinatorSessions in lib/db/schema.ts.
-- Applied by scripts/migrate.mjs on production builds.

alter table coordinator_sessions add column if not exists "lastError" text;
alter table coordinator_sessions add column if not exists "lastErrorAt" timestamptz;
