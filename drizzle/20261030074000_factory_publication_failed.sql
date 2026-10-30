-- target: MIKKA_DATABASE_URL
-- BE-4 (B2): a publication the provider confirmed as failed.
-- One file, one transaction: the CHECK is added NOT VALID, so the brief ACCESS EXCLUSIVE is held only
-- until COMMIT. The VALIDATE is the separate file 20261030074300.
-- factory_publications_status_check is swapped for factory_publications_status_v2_check ('failed' added);
-- every existing row is reserved/succeeded/uncertain and satisfies both. Idempotent.
-- (B4, an approval of a superseded candidate, is derived from "candidateId" and needs no column.)
-- Rollback: alter table factory_publications drop constraint if exists factory_publications_status_v2_check;
--           alter table factory_publications add constraint factory_publications_status_check check (status in ('reserved','succeeded','uncertain')) not valid;
--           delete from schema_migrations where name = '20261030074000_factory_publication_failed.sql';
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'factory_publications_status_v2_check' AND conrelid = 'factory_publications'::regclass) THEN
    ALTER TABLE factory_publications ADD CONSTRAINT factory_publications_status_v2_check CHECK (status IN ('reserved','succeeded','uncertain','failed')) NOT VALID;
  END IF;
END $$;
ALTER TABLE factory_publications DROP CONSTRAINT IF EXISTS factory_publications_status_check;
COMMIT;
