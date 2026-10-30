-- Bots operate computers by default; per-step approval ('ask') is retired
-- (Alex, 2026-10-30, docs/design/decisions.md). Every stored 'ask' becomes
-- 'allow', including rows an admin chose, because that option no longer
-- exists. 'deny' rows are untouched. The version is kept so desktop leases
-- already issued stay valid; the next claim carries 'allow'.
LOCK TABLE workspace_computer_policies IN SHARE ROW EXCLUSIVE MODE;
UPDATE workspace_computer_policies SET permission='allow',"updatedAt"=now() WHERE permission='ask';
ALTER TABLE workspace_computer_policies ALTER COLUMN permission SET DEFAULT 'allow';
ALTER TABLE workspace_computer_policies DROP CONSTRAINT IF EXISTS workspace_computer_policies_permission_check;
ALTER TABLE workspace_computer_policies ADD CONSTRAINT workspace_computer_policies_permission_check CHECK (permission IN ('allow', 'deny'));
