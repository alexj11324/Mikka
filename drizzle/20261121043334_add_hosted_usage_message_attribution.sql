-- target: MIKKA_DATABASE_URL

-- Legacy receipts and unattributed calls keep NULL; existing usageRunId and
-- usageThreadId remain the canonical run and thread attribution.
-- Rollback: revert writers/readers first and leave these nullable columns in
-- place. Dropping them would discard recorded attribution.
ALTER TABLE hosted_usage
  ADD COLUMN IF NOT EXISTS "usageMessageId" text,
  ADD COLUMN IF NOT EXISTS "billingSource" text
    CHECK ("billingSource" IN ('credits', 'subscription', 'api_key'));
