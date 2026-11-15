-- target: MIKKA_DATABASE_URL
-- A conversation's own short title (decision 2026-11-13-1405): a thread is a
-- run and the runs that continue it, and every run of the chain carries the
-- same title. Nullable with no default and no backfill: older conversations
-- keep their bounded fallback. "titleSource" says whether a person set it;
-- a 'manual' title is never overwritten by the generator.
ALTER TABLE agent_runs ADD COLUMN title varchar(60);
ALTER TABLE agent_runs ADD COLUMN "titleSource" text;
-- The same bound as a task's short title (20261110140000).
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_title_compact
  CHECK (title IS NULL OR mikka_issue_short_title_valid(title));
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_title_source
  CHECK ((title IS NULL AND "titleSource" IS NULL)
    OR (title IS NOT NULL AND "titleSource" IS NOT NULL AND "titleSource" IN ('generated','manual')));
