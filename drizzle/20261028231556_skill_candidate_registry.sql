-- Candidate content and lifecycle are immutable provenance; withdrawal only appends.
BEGIN;
CREATE TABLE IF NOT EXISTS improvement_skill_candidates (
  "versionId" uuid PRIMARY KEY REFERENCES improvement_skill_versions(id),
  "userId" text NOT NULL, "issueId" uuid NOT NULL, "agentId" uuid NOT NULL, "repoId" uuid NOT NULL,
  "proposalId" uuid NOT NULL REFERENCES improvement_proposals(id), "factoryTaskId" uuid NOT NULL,
  "candidateId" uuid NOT NULL UNIQUE, repository text NOT NULL,
  "commitSha" text NOT NULL CHECK ("commitSha" ~ '^[a-f0-9]{40}$'), path text NOT NULL,
  "baselineVersionId" uuid NOT NULL REFERENCES improvement_skill_versions(id),
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS improvement_skill_lifecycle (
  id uuid PRIMARY KEY, "userId" text NOT NULL, "issueId" uuid NOT NULL, "repoId" uuid NOT NULL,
  "versionId" uuid NOT NULL REFERENCES improvement_skill_candidates("versionId"),
  operation text NOT NULL CHECK (operation IN ('activate','withdraw')),
  "publicationId" uuid NOT NULL UNIQUE, "approvalId" uuid NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS improvement_skill_run_purposes (
  "runId" uuid PRIMARY KEY, "userId" text NOT NULL,
  "versionId" uuid NOT NULL REFERENCES improvement_skill_versions(id),
  purpose text NOT NULL CHECK (purpose IN ('evaluation','active')),
  "evaluationId" uuid, "createdAt" timestamptz NOT NULL DEFAULT now(),
  CHECK ((purpose='evaluation' AND "evaluationId" IS NOT NULL) OR (purpose='active' AND "evaluationId" IS NULL))
);
CREATE INDEX IF NOT EXISTS improvement_skill_lifecycle_scope_idx
  ON improvement_skill_lifecycle("userId","issueId","repoId","createdAt",id);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['improvement_skill_candidates','improvement_skill_lifecycle','improvement_skill_run_purposes'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(t) AND tgname=t || '_immutable') THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_improvement_rewrite()',t || '_immutable',t);
    END IF;
  END LOOP;
END $$;
COMMIT;
