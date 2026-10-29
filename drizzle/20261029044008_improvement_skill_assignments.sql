-- Minimal builtin assignment provenance; no activation, marketplace or policy.
BEGIN;
CREATE TABLE IF NOT EXISTS improvement_skill_versions (
  id uuid PRIMARY KEY, artifact jsonb NOT NULL, markdown text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS improvement_skill_selections (
  "runId" uuid PRIMARY KEY, "userId" text NOT NULL, "issueId" uuid NOT NULL,
  "agentId" uuid NOT NULL, "repoId" uuid NOT NULL, "deviceId" uuid NOT NULL,
  "versionId" uuid NOT NULL REFERENCES improvement_skill_versions(id),
  "selectedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS improvement_skill_receipts (
  id uuid PRIMARY KEY, "runId" uuid NOT NULL UNIQUE, "userId" text NOT NULL,
  receipt jsonb NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS improvement_factory_links (
  "proposalId" uuid PRIMARY KEY REFERENCES improvement_proposals(id),
  "userId" text NOT NULL, "issueId" uuid NOT NULL, "taskId" uuid NOT NULL,
  "attemptId" uuid NOT NULL, "runId" uuid NOT NULL, request jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(), UNIQUE ("taskId","attemptId")
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['improvement_skill_versions','improvement_skill_selections','improvement_skill_receipts','improvement_factory_links'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(t) AND tgname=t || '_immutable') THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_improvement_rewrite()',t || '_immutable',t);
    END IF;
  END LOOP;
END $$;
COMMIT;
