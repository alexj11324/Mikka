-- Extend the existing approval ledger for candidate-bound Skill activation.
BEGIN;
ALTER TABLE factory_approvals DROP CONSTRAINT IF EXISTS factory_approvals_action_check;
ALTER TABLE factory_approvals ADD CONSTRAINT factory_approvals_action_check
  CHECK (action IN ('deploy_preview','deploy_production','merge','activate_skill'));
COMMIT;
