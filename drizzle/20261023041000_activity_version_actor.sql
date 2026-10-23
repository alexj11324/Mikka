-- MIK-17: record who made each issue_versions change. Both nullable: rows
-- written before this migration have no actor. Set on the server only.
-- Quoted camelCase like the rest of issue_versions ("issueId", "userId").
-- Idempotent, and also upgrades databases that ran the earlier snake_case
-- draft of this migration (actor_type / actor_id).
-- The whole file runs in ONE transaction (migrate.mjs sends it as a single query), so every
-- lock taken below is held until the file commits, including the ACCESS EXCLUSIVE locks from
-- RENAME / ADD / DROP COLUMN and ADD CONSTRAINT. issue_versions is small; if that changes, split
-- the backfill and VALIDATE into separate files.
DO $$
DECLARE
  has_snake_type boolean;
  has_snake_id boolean;
  has_camel_type boolean;
  has_camel_id boolean;
BEGIN
  SELECT
    bool_or(column_name = 'actor_type'), bool_or(column_name = 'actor_id'),
    bool_or(column_name = 'actorType'), bool_or(column_name = 'actorId')
  INTO has_snake_type, has_snake_id, has_camel_type, has_camel_id
  FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name = 'issue_versions';
  IF NOT (has_snake_type OR has_snake_id) THEN
    RETURN;
  END IF;
  -- Any camel column exists (fully or half migrated): merge first. Make sure both camel columns
  -- exist, copy the snake pair only on rows where BOTH camel columns are NULL (never mix one camel
  -- value with one snake value; the actor is a (type, id) pair), then drop the snake columns.
  -- A snake id without a snake type is not copied: an id without a type is unreadable (see the
  -- actor_id_needs_type check below).
  -- Merging before any rename keeps a half-migrated table (e.g. "actorType" + actor_type +
  -- actor_id) from renaming actor_id into place and then skipping those rows' actor_type.
  IF has_camel_type OR has_camel_id THEN
    ALTER TABLE issue_versions ADD COLUMN IF NOT EXISTS "actorType" text;
    ALTER TABLE issue_versions ADD COLUMN IF NOT EXISTS "actorId" text;
    EXECUTE format(
      'UPDATE issue_versions SET "actorType" = %1$s, "actorId" = %2$s WHERE "actorType" IS NULL AND "actorId" IS NULL AND %1$s IS NOT NULL',
      CASE WHEN has_snake_type THEN 'actor_type' ELSE 'NULL' END,
      CASE WHEN has_snake_id THEN 'actor_id' ELSE 'NULL' END);
    ALTER TABLE issue_versions DROP COLUMN IF EXISTS actor_type;
    ALTER TABLE issue_versions DROP COLUMN IF EXISTS actor_id;
  ELSE
    -- Only snake columns: rename them in place.
    IF has_snake_type THEN ALTER TABLE issue_versions RENAME COLUMN actor_type TO "actorType"; END IF;
    IF has_snake_id THEN ALTER TABLE issue_versions RENAME COLUMN actor_id TO "actorId"; END IF;
  END IF;
END $$;
ALTER TABLE issue_versions ADD COLUMN IF NOT EXISTS "actorType" text;
ALTER TABLE issue_versions ADD COLUMN IF NOT EXISTS "actorId" text;
-- Constraints are added once, NOT VALID (the add skips the full-table check), then validated.
-- That split does not shorten locking here: it is all one transaction (see the header).
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
