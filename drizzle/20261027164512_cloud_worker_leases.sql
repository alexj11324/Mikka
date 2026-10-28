-- Serialize worker provisioning across server instances without session-level
-- advisory locks, which are unsafe through transaction-pooled connections.
ALTER TABLE cloud_machines ADD COLUMN IF NOT EXISTS "workerLeaseId" uuid;
ALTER TABLE cloud_machines ADD COLUMN IF NOT EXISTS "workerLeaseUntil" timestamptz;
