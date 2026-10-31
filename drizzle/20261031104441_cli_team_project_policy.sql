-- Shared project/team ceilings use the existing CLI schema and revision trigger.
CREATE TABLE IF NOT EXISTS cli_scope_policies (
  kind text NOT NULL CHECK (kind IN ('team','project')),
  scope_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  cli_run_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  cli_run_policy_version bigint NOT NULL DEFAULT 0,
  cli_run_policy_generation uuid NOT NULL DEFAULT gen_random_uuid(),
  PRIMARY KEY (kind,scope_id)
);
CREATE OR REPLACE TRIGGER cli_run_policy_revision BEFORE INSERT OR UPDATE ON cli_scope_policies FOR EACH ROW EXECUTE FUNCTION cli_run_policy_revision();
-- A run keeps its admitted team/project ceiling when a task is reorganized.
-- A new run resolves the current authoritative workspace relation again.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS cli_policy_hierarchy jsonb;
