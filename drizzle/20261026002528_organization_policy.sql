-- target: DATABASE_URL
BEGIN;
CREATE TABLE IF NOT EXISTS organization_policy_heads (
  workspace_id uuid PRIMARY KEY REFERENCES mikka_workspaces(id),
  version integer NOT NULL CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS organization_policy_versions (
  workspace_id uuid NOT NULL REFERENCES organization_policy_heads(workspace_id),
  version integer NOT NULL CHECK (version > 0),
  signed jsonb NOT NULL,
  actor_id text NOT NULL,
  rollback_of integer,
  published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, version)
);
CREATE OR REPLACE FUNCTION organization_policy_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'policy versions are immutable'; END $$;
DROP TRIGGER IF EXISTS organization_policy_versions_immutable ON organization_policy_versions;
CREATE TRIGGER organization_policy_versions_immutable BEFORE UPDATE OR DELETE ON organization_policy_versions FOR EACH ROW EXECUTE FUNCTION organization_policy_immutable();
COMMIT;
