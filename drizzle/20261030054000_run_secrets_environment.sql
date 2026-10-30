-- target: MIKKA_DATABASE_URL
-- 4e3: the secrets environment a run used (production / preview / development), written at claim,
-- and an optional requested override (only an admin-started run may ask for production).
-- Rollback: alter table agent_runs drop column "secretsEnvironment", drop column "secretsEnvironmentOverride";
--           delete from schema_migrations where name = '20261030054000_run_secrets_environment.sql';
alter table agent_runs add column if not exists "secretsEnvironment" text
  constraint agent_runs_secrets_environment_check check ("secretsEnvironment" in ('production', 'preview', 'development'));
alter table agent_runs add column if not exists "secretsEnvironmentOverride" text
  constraint agent_runs_secrets_environment_override_check check ("secretsEnvironmentOverride" in ('production', 'preview'));
