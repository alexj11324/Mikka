-- Historical runs/messages do not acquire authority retroactively.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "repositoryAdmission" jsonb;
ALTER TABLE run_messages ADD COLUMN IF NOT EXISTS "repositoryAdmission" jsonb;
