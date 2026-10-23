-- MIK-17: record who made each issue_versions change. Both nullable: rows
-- written before this migration have no actor. Set on the server only.
-- Idempotent so a re-run (or a rename) is a no-op.
ALTER TABLE issue_versions ADD COLUMN IF NOT EXISTS actor_type text;
ALTER TABLE issue_versions ADD COLUMN IF NOT EXISTS actor_id text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_versions_actor_type_check') THEN
    ALTER TABLE issue_versions ADD CONSTRAINT issue_versions_actor_type_check CHECK (actor_type IS NULL OR actor_type IN ('user', 'agent', 'system'));
  END IF;
END $$;
