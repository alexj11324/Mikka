-- target: MIKKA_DATABASE_URL
-- Second half of 20261030074000 (CHECKs added NOT VALID there). Separate file = separate transaction:
-- VALIDATE takes SHARE UPDATE EXCLUSIVE, so reads and writes continue while existing rows are scanned.
-- Validating an already valid constraint is a no-op; retry safely after lock contention.
-- Rollback: delete from schema_migrations where name = '20261030074300_factory_publication_failed_validate.sql';
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';
ALTER TABLE factory_publications VALIDATE CONSTRAINT factory_publications_status_v2_check;
ALTER TABLE factory_approvals VALIDATE CONSTRAINT factory_approvals_invalidation_check;
COMMIT;
