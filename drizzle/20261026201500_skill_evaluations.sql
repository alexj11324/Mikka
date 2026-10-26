-- Frozen, server-owned benchmark assignments and actual execution results.
BEGIN;
CREATE TABLE IF NOT EXISTS improvement_benchmark_instances (
  id uuid PRIMARY KEY, "userId" text NOT NULL, "issueId" uuid NOT NULL,
  "agentId" uuid NOT NULL, "repoId" uuid NOT NULL, "sourceRunId" uuid NOT NULL,
  "sourceCommit" text NOT NULL CHECK ("sourceCommit" ~ '^[a-f0-9]{40}$'),
  "definitionDigest" text NOT NULL, "instanceDigest" text NOT NULL,
  seed text NOT NULL CHECK (seed ~ '^[a-f0-9]{64}$'), settings jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("userId","sourceRunId","definitionDigest")
);
CREATE TABLE IF NOT EXISTS improvement_skill_evaluations (
  id uuid PRIMARY KEY, "instanceId" uuid NOT NULL REFERENCES improvement_benchmark_instances(id),
  "userId" text NOT NULL, "proposalId" uuid NOT NULL REFERENCES improvement_proposals(id),
  "candidateVersionId" uuid NOT NULL REFERENCES improvement_skill_candidates("versionId"),
  scope jsonb NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("instanceId","candidateVersionId")
);
CREATE TABLE IF NOT EXISTS improvement_benchmark_runs (
  "runId" uuid PRIMARY KEY, "instanceId" uuid NOT NULL REFERENCES improvement_benchmark_instances(id),
  "evaluationId" uuid REFERENCES improvement_skill_evaluations(id), "caseId" text NOT NULL,
  arm text NOT NULL CHECK (arm IN ('training','baseline','candidate')),
  "versionId" uuid NOT NULL REFERENCES improvement_skill_versions(id), "userId" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((arm='training' AND "evaluationId" IS NULL) OR (arm IN ('baseline','candidate') AND "evaluationId" IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS improvement_benchmark_runs_case_idx
  ON improvement_benchmark_runs("instanceId","evaluationId","caseId",arm) WHERE "evaluationId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS improvement_benchmark_training_case_idx
  ON improvement_benchmark_runs("instanceId","caseId",arm) WHERE "evaluationId" IS NULL;
CREATE TABLE IF NOT EXISTS improvement_evaluation_results (
  "evaluationId" uuid PRIMARY KEY REFERENCES improvement_skill_evaluations(id),
  result jsonb NOT NULL, digest text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp()
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['improvement_benchmark_instances','improvement_skill_evaluations','improvement_benchmark_runs','improvement_evaluation_results'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(t) AND tgname=t || '_immutable') THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_improvement_rewrite()',t || '_immutable',t);
    END IF;
  END LOOP;
END $$;
COMMIT;
