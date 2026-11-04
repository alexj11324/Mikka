-- Historical attribution stays NULL: current ownership must not rewrite past evidence.
ALTER TABLE artifact_versions ADD COLUMN IF NOT EXISTS "executionIdentity" jsonb;
