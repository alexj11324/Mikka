-- target: MIKKA_DATABASE_URL
-- BE-4 (B2/B4): a publication the provider confirmed as failed, and why an approval stopped counting.
-- Two files = two transactions, like 20261030054000: here (1) nullable columns, no rewrite;
-- (2) CHECKs added NOT VALID, so ACCESS EXCLUSIVE is held only until COMMIT. 20261030074100 VALIDATEs.
-- factory_publications_status_check is swapped for factory_publications_status_v2_check ('failed' added);
-- every existing row is reserved/succeeded/uncertain and satisfies both. Idempotent.
-- Rollback: alter table factory_approvals drop column "invalidatedAt", drop column "invalidationReason";
--           alter table factory_publications drop constraint if exists factory_publications_status_v2_check;
--           alter table factory_publications add constraint factory_publications_status_check check (status in ('reserved','succeeded','uncertain')) not valid;
--           delete from schema_migrations where name = '20261030074000_factory_publication_failed.sql';
BEGIN;
SET LOCAL lock_timeout = '5s';
-- Step 1: columns.
alter table factory_approvals add column if not exists "invalidatedAt" timestamptz;
alter table factory_approvals add column if not exists "invalidationReason" text;
-- Step 2: constraints, NOT VALID.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'factory_publications_status_v2_check' AND conrelid = 'factory_publications'::regclass) THEN
    ALTER TABLE factory_publications ADD CONSTRAINT factory_publications_status_v2_check CHECK (status IN ('reserved','succeeded','uncertain','failed')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'factory_approvals_invalidation_check' AND conrelid = 'factory_approvals'::regclass) THEN
    ALTER TABLE factory_approvals ADD CONSTRAINT factory_approvals_invalidation_check CHECK (("invalidatedAt" IS NULL) = ("invalidationReason" IS NULL) AND ("invalidationReason" IS NULL OR "invalidationReason" IN ('candidateSuperseded'))) NOT VALID;
  END IF;
END $$;
ALTER TABLE factory_publications DROP CONSTRAINT IF EXISTS factory_publications_status_check;
COMMIT;
