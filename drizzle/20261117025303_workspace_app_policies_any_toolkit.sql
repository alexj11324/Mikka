-- target: MIKKA_DATABASE_URL
-- 团队权限 › 允许使用的应用 governs any Composio toolkit, not a fixed list of
-- five: which apps exist is Composio's live toolkit list. The row still has to
-- be a toolkit slug, and never one of Mikka's own integrations (GitHub, Linear,
-- Telegram), which bots do not reach through a per-app tool.
-- Rollback: ALTER TABLE workspace_app_policies DROP CONSTRAINT IF EXISTS workspace_app_policies_app_check; (re-adding the old list fails once rows outside it exist); DELETE FROM schema_migrations WHERE name = '20261117025303_workspace_app_policies_any_toolkit.sql';
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE workspace_app_policies DROP CONSTRAINT IF EXISTS workspace_app_policies_app_check;
ALTER TABLE workspace_app_policies ADD CONSTRAINT workspace_app_policies_app_check
  CHECK (app ~ '^[a-z][a-z0-9_]{0,63}$' AND app NOT IN ('github', 'linear', 'telegram'));
COMMIT;
