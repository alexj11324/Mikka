-- What the GitHub App grants is never asked (decision
-- 2026-11-01-1310-no-ask-for-app-granted-abilities): git_push and
-- 创建 Pull Request offer only allow / deny. A stored ask becomes allow, a
-- publication waiting on a pull request card goes back to pending, and a
-- pending pull request card is closed. Production held none of these when
-- this was written; the statements are idempotent.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
UPDATE agent_kit_heads SET cli_run_policy = jsonb_set(cli_run_policy, '{permissions,git_push}', '"allow"')
  WHERE cli_run_policy->'permissions'->>'git_push' = 'ask';
UPDATE agents SET cli_run_policy = jsonb_set(cli_run_policy, '{permissions,git_push}', '"allow"')
  WHERE cli_run_policy->'permissions'->>'git_push' = 'ask';
UPDATE cli_scope_policies SET cli_run_policy = jsonb_set(cli_run_policy, '{permissions,git_push}', '"allow"')
  WHERE cli_run_policy->'permissions'->>'git_push' = 'ask';
UPDATE workspace_computer_policies SET cli_run_policy = jsonb_set(cli_run_policy, '{permissions,git_push}', '"allow"')
  WHERE cli_run_policy->'permissions'->>'git_push' = 'ask';
UPDATE agent_kit_heads SET external_write_permissions = jsonb_set(external_write_permissions, '{github_pull_request}', '"allow"')
  WHERE external_write_permissions->>'github_pull_request' = 'ask';
UPDATE workspace_computer_policies SET external_write_permissions = jsonb_set(external_write_permissions, '{github_pull_request}', '"allow"')
  WHERE external_write_permissions->>'github_pull_request' = 'ask';
UPDATE run_publications SET status = 'pending', "workflowRunId" = NULL, "updatedAt" = now() WHERE status = 'awaiting_approval';
UPDATE pending_actions SET status = 'declined', "decidedAt" = now() WHERE action = 'approve_pull_request' AND status = 'pending';
COMMIT;
