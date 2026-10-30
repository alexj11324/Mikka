-- target: MIKKA_DATABASE_URL
-- 4e3: the secrets environment a run used (production / preview / development), written at claim,
-- and a reserved override column. #452 has no writer for the override: the claim route refuses any
-- non-null value with 403 secretEnvironmentOverrideUnsupported (the audited override lands after #432).
-- Three steps: (1) nullable columns, no rewrite; (2) CHECKs added NOT VALID, enforced for new/changed rows
-- without scanning history under the DDL lock; (3) VALIDATE, which scans under SHARE UPDATE EXCLUSIVE only.
-- Existing rows are NULL and satisfy both checks. Idempotent; retry safely after lock contention.
-- Rollback: alter table agent_runs drop column "secretsEnvironment", drop column "secretsEnvironmentOverride";
--           delete from schema_migrations where name = '20261030054000_run_secrets_environment.sql';
SET LOCAL lock_timeout = '5s';
-- Step 1: columns.
alter table agent_runs add column if not exists "secretsEnvironment" text;
alter table agent_runs add column if not exists "secretsEnvironmentOverride" text;
-- Step 2: constraints, NOT VALID.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_runs_secrets_environment_check' AND conrelid = 'agent_runs'::regclass) THEN
    ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_secrets_environment_check CHECK ("secretsEnvironment" IN ('production', 'preview', 'development')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_runs_secrets_environment_override_check' AND conrelid = 'agent_runs'::regclass) THEN
    ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_secrets_environment_override_check CHECK ("secretsEnvironmentOverride" IN ('production', 'preview')) NOT VALID;
  END IF;
END $$;
-- Step 3: validate.
ALTER TABLE agent_runs VALIDATE CONSTRAINT agent_runs_secrets_environment_check;
ALTER TABLE agent_runs VALIDATE CONSTRAINT agent_runs_secrets_environment_override_check;
