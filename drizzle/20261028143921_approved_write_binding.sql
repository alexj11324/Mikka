-- target: MIKKA_DATABASE_URL
ALTER TABLE operation_ledger ADD COLUMN IF NOT EXISTS "invokedAt" timestamptz;
-- Proposal decision remains in pending_actions; execution state lives only in ledger.
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS "intentKey" text;
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS "operationBinding" jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS pending_actions_owner_intent ON pending_actions ("userId", "intentKey") WHERE "intentKey" IS NOT NULL;
