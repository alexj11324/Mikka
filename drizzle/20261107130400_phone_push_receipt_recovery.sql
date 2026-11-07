-- Receipts survive a COMMIT -> Workflow.start crash. The existing reconcile
-- safety sweep checks due rows; a fenced lease serializes it with the Workflow.
ALTER TABLE mobile_push_receipts
  ADD COLUMN next_check_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
  ADD COLUMN check_count smallint NOT NULL DEFAULT 0 CHECK (check_count BETWEEN 0 AND 2),
  ADD COLUMN lease_until timestamptz,
  ADD COLUMN lease_id uuid;
UPDATE mobile_push_receipts SET next_check_at = created_at + interval '15 minutes';
CREATE INDEX mobile_push_receipts_next_check ON mobile_push_receipts(next_check_at);
