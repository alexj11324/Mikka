-- Extend the existing workspace policy, retaining its owner, version and revocation boundary.
ALTER TABLE workspace_computer_policies DROP CONSTRAINT IF EXISTS workspace_computer_policies_permission_check;
ALTER TABLE workspace_computer_policies ADD CONSTRAINT workspace_computer_policies_permission_check CHECK (permission IN ('allow', 'ask', 'deny'));
