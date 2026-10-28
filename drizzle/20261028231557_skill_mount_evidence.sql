BEGIN;
CREATE TABLE IF NOT EXISTS improvement_skill_mounts (
  "runId" uuid PRIMARY KEY, "userId" text NOT NULL, "deviceId" uuid NOT NULL,
  "receiptId" uuid NOT NULL REFERENCES improvement_skill_receipts(id),
  "versionId" uuid NOT NULL REFERENCES improvement_skill_versions(id),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  "sessionId" text NOT NULL CHECK (length("sessionId") BETWEEN 1 AND 500),
  execution jsonb, runtime jsonb,
  "mountedAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now()
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('improvement_skill_mounts') AND tgname='improvement_skill_mounts_immutable') THEN
    CREATE TRIGGER improvement_skill_mounts_immutable BEFORE UPDATE OR DELETE ON improvement_skill_mounts
      FOR EACH ROW EXECUTE FUNCTION reject_improvement_rewrite();
  END IF;
END $$;
COMMIT;
