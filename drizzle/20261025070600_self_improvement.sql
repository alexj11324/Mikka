-- Additive offline improvement ledger. No active Skill or Factory stage writes.
BEGIN;
CREATE TABLE IF NOT EXISTS improvement_scorers (
  digest text PRIMARY KEY, id text NOT NULL, version integer NOT NULL,
  definition jsonb NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), UNIQUE (id,version)
);
CREATE TABLE IF NOT EXISTS improvement_feedback (
  id uuid PRIMARY KEY, "userId" text NOT NULL, "eventId" uuid NOT NULL,
  "runId" uuid NOT NULL, "issueId" uuid NOT NULL,
  fingerprint text NOT NULL, verdict text NOT NULL CHECK (verdict IN ('positive','negative','unknown')),
  note text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), UNIQUE ("userId","eventId")
);
CREATE TABLE IF NOT EXISTS improvement_scores (
  id uuid PRIMARY KEY REFERENCES improvement_feedback(id), "userId" text NOT NULL,
  "runId" uuid NOT NULL, bucket text NOT NULL,
  "scorerDigest" text NOT NULL REFERENCES improvement_scorers(digest),
  outcome text NOT NULL CHECK (outcome IN ('failure','unknown')), reason text NOT NULL,
  snapshot jsonb NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS improvement_scores_bucket_idx ON improvement_scores ("userId",bucket,"createdAt");
CREATE TABLE IF NOT EXISTS improvement_proposals (
  id uuid PRIMARY KEY, "userId" text NOT NULL, bucket text NOT NULL,
  fingerprint text NOT NULL, "issueId" uuid NOT NULL,
  "scorerDigest" text NOT NULL REFERENCES improvement_scorers(digest),
  candidate jsonb NOT NULL, result jsonb NOT NULL,
  status text NOT NULL CHECK (status='awaiting_independent_review'),
  "createdAt" timestamptz NOT NULL DEFAULT now(), UNIQUE ("userId", fingerprint)
);
CREATE TABLE IF NOT EXISTS improvement_proposal_sources (
  "proposalId" uuid NOT NULL REFERENCES improvement_proposals(id),
  "scoreId" uuid NOT NULL REFERENCES improvement_scores(id),
  "userId" text NOT NULL, bucket text NOT NULL, "runId" uuid NOT NULL,
  PRIMARY KEY ("userId",bucket,"runId"), UNIQUE ("scoreId")
);
-- Source IDs are immutable provenance, not lifecycle FKs: existing Agent/run
-- deletion must not be blocked. Reads still require a live owned run and issue
-- access. Retention/deletion is a separate #210 decision, not a new delete API.
-- These are evidence ledgers. App operations only append; no edit/delete API.
CREATE OR REPLACE FUNCTION reject_improvement_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'improvement evidence is immutable'; END;
$$;
CREATE TRIGGER improvement_scorers_immutable BEFORE UPDATE OR DELETE ON improvement_scorers FOR EACH ROW EXECUTE FUNCTION reject_improvement_rewrite();
CREATE TRIGGER improvement_feedback_immutable BEFORE UPDATE OR DELETE ON improvement_feedback FOR EACH ROW EXECUTE FUNCTION reject_improvement_rewrite();
CREATE TRIGGER improvement_scores_immutable BEFORE UPDATE OR DELETE ON improvement_scores FOR EACH ROW EXECUTE FUNCTION reject_improvement_rewrite();
CREATE TRIGGER improvement_proposals_immutable BEFORE UPDATE OR DELETE ON improvement_proposals FOR EACH ROW EXECUTE FUNCTION reject_improvement_rewrite();
CREATE TRIGGER improvement_sources_immutable BEFORE UPDATE OR DELETE ON improvement_proposal_sources FOR EACH ROW EXECUTE FUNCTION reject_improvement_rewrite();
COMMIT;
