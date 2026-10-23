-- MIK-17: record who made each issue_versions change. Both nullable: rows
-- written before this migration have no actor. Set on the server only.
-- Quoted camelCase like the rest of issue_versions ("issueId", "userId").
-- Idempotent: also upgrades databases that ran the earlier snake_case draft
-- (actor_type / actor_id) of this migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'issue_versions' AND column_name = 'actor_type')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'issue_versions' AND column_name = 'actorType') THEN
    ALTER TABLE issue_versions RENAME COLUMN actor_type TO "actorType";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'issue_versions' AND column_name = 'actor_id')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'issue_versions' AND column_name = 'actorId') THEN
    ALTER TABLE issue_versions RENAME COLUMN actor_id TO "actorId";
  END IF;
END $$;
ALTER TABLE issue_versions ADD COLUMN IF NOT EXISTS "actorType" text;
ALTER TABLE issue_versions ADD COLUMN IF NOT EXISTS "actorId" text;
ALTER TABLE issue_versions DROP CONSTRAINT IF EXISTS issue_versions_actor_type_check;
ALTER TABLE issue_versions ADD CONSTRAINT issue_versions_actor_type_check CHECK ("actorType" IS NULL OR "actorType" IN ('user', 'agent', 'system'));
-- An actor id without a type is unreadable; a type without an id is fine (e.g. system).
ALTER TABLE issue_versions DROP CONSTRAINT IF EXISTS issue_versions_actor_id_needs_type_check;
ALTER TABLE issue_versions ADD CONSTRAINT issue_versions_actor_id_needs_type_check CHECK ("actorId" IS NULL OR "actorType" IS NOT NULL);
