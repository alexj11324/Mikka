-- A thread worker owns a distinct scoped device and provisioning lease.
ALTER TABLE thread_machines ADD COLUMN IF NOT EXISTS "workerLeaseId" uuid;
ALTER TABLE thread_machines ADD COLUMN IF NOT EXISTS "workerLeaseUntil" timestamptz;
