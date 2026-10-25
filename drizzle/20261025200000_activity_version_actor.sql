-- MIK-17: additive, nullable actor columns; historical rows remain NULL.
-- No indexes/backfill. NOT VALID avoids scanning history under the DDL lock;
-- both checks immediately enforce all new/changed rows. Existing NULLs satisfy them.
-- Runner uses one transaction; ALTER TABLE takes ACCESS EXCLUSIVE briefly.
-- Retry safely after lock contention. Rollback requires an explicit later migration
-- dropping these checks/columns after old code is deployed (loses actor history).
SET LOCAL lock_timeout = '5s';
ALTER TABLE issue_versions ADD COLUMN IF NOT EXISTS actor_type text;
ALTER TABLE issue_versions ADD COLUMN IF NOT EXISTS actor_id text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_versions_actor_type_check' AND conrelid = 'issue_versions'::regclass) THEN
    ALTER TABLE issue_versions ADD CONSTRAINT issue_versions_actor_type_check CHECK (actor_type IS NULL OR actor_type IN ('user', 'agent', 'system')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_versions_actor_id_needs_type_check' AND conrelid = 'issue_versions'::regclass) THEN
    ALTER TABLE issue_versions ADD CONSTRAINT issue_versions_actor_id_needs_type_check CHECK (actor_id IS NULL OR actor_type IS NOT NULL) NOT VALID;
  END IF;
END $$;
