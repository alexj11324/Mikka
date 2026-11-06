-- target: MIKKA_DATABASE_URL
-- Retain an additive image's official base after its release leaves the current
-- and rollback catalogues. The existing provisioning/transfer writes carry it.
ALTER TABLE thread_machines ADD COLUMN IF NOT EXISTS "templateKind" text
  CHECK ("templateKind" IN ('desktop','claude','codex'));
UPDATE thread_machines SET "templateKind"="snapshotId"
  WHERE "templateKind" IS NULL AND "snapshotId" IN ('desktop','claude','codex');
