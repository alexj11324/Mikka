-- target: MIKKA_DATABASE_URL
-- Reuse the workspace policy record. Computer and external-write revisions
-- remain independent, so a change to one does not grant the other.
ALTER TABLE workspace_computer_policies ADD COLUMN IF NOT EXISTS external_write_permissions jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE workspace_computer_policies ADD COLUMN IF NOT EXISTS external_write_policy_version bigint NOT NULL DEFAULT 0;
CREATE OR REPLACE FUNCTION workspace_external_write_policy_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.external_write_permissions IS DISTINCT FROM OLD.external_write_permissions THEN
    NEW.external_write_policy_version := OLD.external_write_policy_version + 1;
  ELSIF NEW.external_write_policy_version IS DISTINCT FROM OLD.external_write_policy_version THEN
    RAISE EXCEPTION 'workspace external write policy version is automatic';
  END IF;
  IF jsonb_typeof(NEW.external_write_permissions) <> 'object' THEN
    RAISE EXCEPTION 'workspace external write policy must be an object';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS workspace_external_write_policy_revision ON workspace_computer_policies;
CREATE TRIGGER workspace_external_write_policy_revision BEFORE UPDATE ON workspace_computer_policies FOR EACH ROW EXECUTE FUNCTION workspace_external_write_policy_revision();
