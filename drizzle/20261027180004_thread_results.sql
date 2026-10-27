-- A finished thread's filesystem-only result snapshot is retained after its
-- sandbox is destroyed, so a local branch and uncommitted work are not lost.
ALTER TABLE thread_machines ADD COLUMN IF NOT EXISTS "resultSnapshotId" text;
