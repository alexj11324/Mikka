-- How much each Coordinator event matters; background events do not wake it.
-- Mirrors coordinatorEvents in lib/db/schema.ts.
-- Applied by scripts/migrate.mjs on production builds.

alter table coordinator_events add column if not exists tier text;
