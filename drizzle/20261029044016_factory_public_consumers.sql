-- Compose the public Factory lifecycle and publication consumer contracts.
-- Historical SQL remains unchanged; this also upgrades an existing #395 schema.
BEGIN;
ALTER TABLE factory_tasks ADD COLUMN IF NOT EXISTS "botId" uuid;
-- Source events are historical identity. Every access revalidates their live
-- owner/Bot scope; deleting a Bot must not migrate its tasks to Coordinator scope.
ALTER TABLE factory_tasks DROP CONSTRAINT IF EXISTS "factory_tasks_sourceEventId_fkey";
ALTER TABLE factory_questions DROP CONSTRAINT IF EXISTS "factory_questions_sourceEventId_fkey";

ALTER TABLE factory_evidence_reads ADD COLUMN IF NOT EXISTS "humanSessionId" text;
ALTER TABLE factory_evidence_reads ADD COLUMN IF NOT EXISTS "principalId" text;
UPDATE factory_evidence_reads SET "principalId"='session:' || "humanSessionId" WHERE "principalId" IS NULL;
ALTER TABLE factory_evidence_reads ALTER COLUMN "principalId" SET NOT NULL;
ALTER TABLE factory_evidence_reads ALTER COLUMN "humanSessionId" DROP NOT NULL;

ALTER TABLE factory_approvals ADD COLUMN IF NOT EXISTS "principalId" text;
ALTER TABLE factory_approvals ADD COLUMN IF NOT EXISTS "decisionCredentialId" text;
ALTER TABLE factory_approvals ADD COLUMN IF NOT EXISTS "decisionScope" jsonb;
ALTER TABLE factory_approvals ADD COLUMN IF NOT EXISTS "decisionEvidence" jsonb;
UPDATE factory_approvals SET "principalId"='session:' || "humanSessionId" WHERE "principalId" IS NULL;
ALTER TABLE factory_approvals ALTER COLUMN "principalId" SET NOT NULL;
ALTER TABLE factory_approvals ALTER COLUMN "humanSessionId" DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS factory_approval_policy_once_idx
  ON factory_approvals (("decisionEvidence"->>'issuer'),"decisionCredentialId")
  WHERE "decisionCredentialId" IS NOT NULL;

ALTER TABLE factory_approval_controls ADD COLUMN IF NOT EXISTS "humanSessionId" text;
ALTER TABLE factory_approval_controls ADD COLUMN IF NOT EXISTS "principalId" text;
UPDATE factory_approval_controls SET "principalId"='session:' || "humanSessionId" WHERE "principalId" IS NULL;
ALTER TABLE factory_approval_controls ALTER COLUMN "principalId" SET NOT NULL;
ALTER TABLE factory_approval_controls ALTER COLUMN "humanSessionId" DROP NOT NULL;
COMMIT;
