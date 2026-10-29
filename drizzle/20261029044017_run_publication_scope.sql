-- target: MIKKA_DATABASE_URL
-- Pin the task generation and already authorized title for external publication.
-- Unknown legacy generations stay null; never backfill them from a later scope.
ALTER TABLE run_publications ADD COLUMN IF NOT EXISTS "scopeVersion" integer;
ALTER TABLE run_publications ADD COLUMN IF NOT EXISTS "issueTitle" text;
