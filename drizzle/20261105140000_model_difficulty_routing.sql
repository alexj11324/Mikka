-- #1329: task model routing is enabled by default for every owner/workspace.
-- Toggling it never rewrites the person's saved model list.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE model_order_settings
  ADD COLUMN IF NOT EXISTS "autoModelRouting" boolean NOT NULL DEFAULT true;
COMMIT;
