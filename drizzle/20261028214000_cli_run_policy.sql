-- CLI policies are independent of external-write and computer permissions.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS cli_run_policy jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS cli_run_policy_version bigint NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS cli_run_policy_generation uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE agent_kit_heads ADD COLUMN IF NOT EXISTS cli_run_policy jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE agent_kit_heads ADD COLUMN IF NOT EXISTS cli_run_policy_version bigint NOT NULL DEFAULT 0;
ALTER TABLE agent_kit_heads ADD COLUMN IF NOT EXISTS cli_run_policy_generation uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE workspace_computer_policies ADD COLUMN IF NOT EXISTS cli_run_policy jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE workspace_computer_policies ADD COLUMN IF NOT EXISTS cli_run_policy_version bigint NOT NULL DEFAULT 0;
ALTER TABLE workspace_computer_policies ADD COLUMN IF NOT EXISTS cli_run_policy_generation uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE agent_tool_approvals ADD COLUMN IF NOT EXISTS "policyRevision" text;
CREATE OR REPLACE FUNCTION cli_run_policy_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF jsonb_typeof(NEW.cli_run_policy) <> 'object' THEN RAISE EXCEPTION 'CLI policy must be an object'; END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.cli_run_policy_version := CASE WHEN NEW.cli_run_policy = '{}'::jsonb THEN 0 ELSE 1 END;
    NEW.cli_run_policy_generation := gen_random_uuid();
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.cli_run_policy_generation IS DISTINCT FROM OLD.cli_run_policy_generation THEN RAISE EXCEPTION 'CLI policy generation is automatic'; END IF;
    IF NEW.cli_run_policy IS DISTINCT FROM OLD.cli_run_policy THEN
      NEW.cli_run_policy_version := OLD.cli_run_policy_version + 1;
    ELSIF NEW.cli_run_policy_version IS DISTINCT FROM OLD.cli_run_policy_version THEN
      RAISE EXCEPTION 'CLI policy version is automatic';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cli_run_policy_revision BEFORE INSERT OR UPDATE ON agent_kit_heads FOR EACH ROW EXECUTE FUNCTION cli_run_policy_revision();
CREATE TRIGGER cli_run_policy_revision BEFORE INSERT OR UPDATE ON workspace_computer_policies FOR EACH ROW EXECUTE FUNCTION cli_run_policy_revision();

CREATE TRIGGER cli_run_policy_revision BEFORE INSERT OR UPDATE ON agents FOR EACH ROW EXECUTE FUNCTION cli_run_policy_revision();
