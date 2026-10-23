-- target: DATABASE_URL
-- Additive live-tool approval states; no image/result/credential persistence.
-- Existing pending rows stay pending. Only live tools can claim approved work.
-- Small approval ledger constraint replacement, no data rewrite or backfill.
-- Rollback only after live streams have drained and approved/cancelled rows are removed.
ALTER TABLE computer_requests DROP CONSTRAINT IF EXISTS computer_requests_status_check;
ALTER TABLE computer_requests ADD CONSTRAINT computer_requests_status_check
  CHECK (status IN ('pending', 'approved', 'executing', 'complete', 'failed', 'denied', 'cancelled'));
