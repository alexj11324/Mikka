-- target: MIKKA_DATABASE_URL
-- Second half of 20261030114200 (CHECKs added NOT VALID there). Separate file = separate transaction:
-- VALIDATE takes SHARE UPDATE EXCLUSIVE, so agent_runs reads and writes continue while existing rows
-- are scanned. Validating an already valid constraint is a no-op; retry safely after lock contention.
-- Rollback: delete from schema_migrations where name = '20261030114300_run_secrets_environment_validate.sql';
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';
ALTER TABLE agent_runs VALIDATE CONSTRAINT agent_runs_secrets_environment_check;
ALTER TABLE agent_runs VALIDATE CONSTRAINT agent_runs_secrets_environment_override_check;
COMMIT;
