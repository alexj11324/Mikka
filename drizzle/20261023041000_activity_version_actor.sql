-- MIK-17: record who made each issue_versions change. Both nullable: rows
-- written before this migration have no actor. Set on the server only.
-- Quoted camelCase like the rest of issue_versions ("issueId", "userId").
-- Idempotent, and also upgrades databases that ran the earlier snake_case
-- draft of this migration (actor_type / actor_id).
DO $$
DECLARE
  pair text[];
  has_snake boolean;
  has_camel boolean;
BEGIN
  FOREACH pair SLICE 1 IN ARRAY ARRAY[['actor_type', 'actorType'], ['actor_id', 'actorId']] LOOP
    SELECT count(*) > 0 INTO has_snake FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'issue_versions' AND column_name = pair[1];
    SELECT count(*) > 0 INTO has_camel FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'issue_versions' AND column_name = pair[2];
    IF has_snake AND NOT has_camel THEN
      EXECUTE format('ALTER TABLE issue_versions RENAME COLUMN %I TO %I', pair[1], pair[2]);
    ELSIF has_snake AND has_camel THEN
      -- Both exist (e.g. the old draft ran after the new column was added): keep camelCase, fill its gaps, drop snake.
      EXECUTE format('UPDATE issue_versions SET %I = coalesce(%I, %I) WHERE %I IS NULL AND %I IS NOT NULL', pair[2], pair[2], pair[1], pair[2], pair[1]);
      EXECUTE format('ALTER TABLE issue_versions DROP COLUMN %I', pair[1]);
    END IF;
  END LOOP;
END $$;
ALTER TABLE issue_versions ADD COLUMN IF NOT EXISTS "actorType" text;
ALTER TABLE issue_versions ADD COLUMN IF NOT EXISTS "actorId" text;
-- Constraints are added once (NOT VALID, so the add takes no long lock), then validated.
-- A constraint renamed along with its column keeps its name and is left alone.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'issue_versions'::regclass AND conname = 'issue_versions_actor_type_check') THEN
    ALTER TABLE issue_versions ADD CONSTRAINT issue_versions_actor_type_check CHECK ("actorType" IS NULL OR "actorType" IN ('user', 'agent', 'system')) NOT VALID;
  END IF;
  -- An actor id without a type is unreadable; a type without an id is fine (e.g. system).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'issue_versions'::regclass AND conname = 'issue_versions_actor_id_needs_type_check') THEN
    ALTER TABLE issue_versions ADD CONSTRAINT issue_versions_actor_id_needs_type_check CHECK ("actorId" IS NULL OR "actorType" IS NOT NULL) NOT VALID;
  END IF;
END $$;
ALTER TABLE issue_versions VALIDATE CONSTRAINT issue_versions_actor_type_check;
ALTER TABLE issue_versions VALIDATE CONSTRAINT issue_versions_actor_id_needs_type_check;
