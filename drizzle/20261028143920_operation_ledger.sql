-- target: MIKKA_DATABASE_URL
-- Independent of run attempts and existing publication/approval reservations.
CREATE TABLE IF NOT EXISTS operation_ledger (
  "operationId" uuid PRIMARY KEY,
  "ownerId" text NOT NULL,
  "workspaceId" text NOT NULL,
  binding jsonb NOT NULL,
  "idempotencyKey" text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','executing','succeeded','failed','uncertain')),
  "attemptToken" uuid,
  "runId" uuid,
  receipt jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "updatedAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status = 'reserved') = ("attemptToken" IS NULL)),
  CHECK ((status = 'succeeded') = (receipt IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS operation_ledger_scope ON operation_ledger ("ownerId", "workspaceId", status);
