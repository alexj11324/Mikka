-- Team provenance and review append to the existing immutable Skill artifacts.
-- No second byte store, archive installer, plugin execution or permission grant.
BEGIN;
CREATE TABLE IF NOT EXISTS improvement_team_skill_metadata (
  "versionId" uuid PRIMARY KEY REFERENCES improvement_skill_versions(id),
  "workspaceId" uuid NOT NULL, "skillId" uuid NOT NULL,
  "catalogOwnerId" text NOT NULL, "submittedBy" text NOT NULL,
  name text NOT NULL, description text, license text NOT NULL,
  manifest jsonb NOT NULL CHECK(manifest='{"format":"single-skill-md-v1","dependencies":[],"permissions":[]}'::jsonb),
  source text NOT NULL CHECK (source='workspace-upload'),
  "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("versionId","workspaceId")
);
CREATE INDEX IF NOT EXISTS improvement_team_skill_catalog_idx
  ON improvement_team_skill_metadata("workspaceId","skillId","createdAt");
CREATE TABLE IF NOT EXISTS improvement_team_skill_reviews (
  id uuid PRIMARY KEY, "versionId" uuid NOT NULL, "workspaceId" uuid NOT NULL,
  "reviewerId" text NOT NULL, operation text NOT NULL CHECK(operation IN ('approve','withdraw')),
  sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY("versionId","workspaceId") REFERENCES improvement_team_skill_metadata("versionId","workspaceId"),
  UNIQUE("versionId",operation)
);
CREATE TRIGGER improvement_team_skill_metadata_immutable BEFORE UPDATE OR DELETE ON improvement_team_skill_metadata
  FOR EACH ROW EXECUTE FUNCTION reject_improvement_rewrite();
CREATE TRIGGER improvement_team_skill_reviews_immutable BEFORE UPDATE OR DELETE ON improvement_team_skill_reviews
  FOR EACH ROW EXECUTE FUNCTION reject_improvement_rewrite();
COMMIT;
