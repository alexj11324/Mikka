-- Preserve immutable historical synthetic rows; new proposals await real model execution.
BEGIN;
ALTER TABLE improvement_proposals DROP CONSTRAINT IF EXISTS improvement_proposals_status_check;
ALTER TABLE improvement_proposals ADD CONSTRAINT improvement_proposals_status_check
  CHECK (status IN ('awaiting_independent_review','awaiting_model_candidate'));
COMMIT;
