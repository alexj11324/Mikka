-- One immutable activation and withdrawal per publication; keep historical events.
BEGIN;
ALTER TABLE improvement_skill_lifecycle DROP CONSTRAINT IF EXISTS "improvement_skill_lifecycle_publicationId_key";
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='improvement_skill_lifecycle'::regclass AND conname='improvement_skill_lifecycle_publication_operation_key') THEN
    ALTER TABLE improvement_skill_lifecycle ADD CONSTRAINT improvement_skill_lifecycle_publication_operation_key UNIQUE ("publicationId",operation);
  END IF;
END $$;
COMMIT;
