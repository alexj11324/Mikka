-- The existing run-recovery timer owns task machines independently of a
-- particular Workflow execution. A due row survives a lost wake or process.
ALTER TABLE thread_machines ADD COLUMN IF NOT EXISTS "lifecycleAt" timestamptz DEFAULT now();
ALTER TABLE thread_machines ADD COLUMN IF NOT EXISTS lifecycle jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Adopted historical rows no longer own a provider resource.
UPDATE thread_machines SET "lifecycleAt"=NULL
WHERE state='ended' AND "sandboxId" IS NULL AND "workerLeaseId" IS NULL AND "workerLeaseUntil" IS NULL;

CREATE INDEX IF NOT EXISTS thread_machines_lifecycle_due
ON thread_machines ("lifecycleAt") WHERE "lifecycleAt" IS NOT NULL;
