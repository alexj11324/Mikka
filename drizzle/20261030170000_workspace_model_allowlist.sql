-- target: MIKKA_DATABASE_URL
-- 设置 › Bot: 可用模型 (docs/design/bot-settings.md). Admins choose which model families
-- members' bots may use; "defaultModel" becomes the model a new bot starts with and must be
-- one of them. NULL "allowedModels" (every existing row) allows every family, so nothing
-- changes until an admin saves. Constant defaults keep ADD COLUMN metadata-only; the
-- CHECKs scan a table with at most one row per workspace.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS "allowedModels" text[];
-- Optimistic lock for 可用模型 saves (compare-and-set, as BE-15 did for the old defaults).
ALTER TABLE workspace_settings ADD COLUMN IF NOT EXISTS "modelPolicyVersion" integer NOT NULL DEFAULT 0;
ALTER TABLE workspace_settings DROP CONSTRAINT IF EXISTS workspace_settings_allowed_models_check;
ALTER TABLE workspace_settings ADD CONSTRAINT workspace_settings_allowed_models_check
  CHECK ("allowedModels" IS NULL OR (cardinality("allowedModels") >= 1 AND "allowedModels" <@ ARRAY['mikka', 'codex', 'claude']::text[]));
ALTER TABLE workspace_settings DROP CONSTRAINT IF EXISTS workspace_settings_starting_model_allowed_check;
ALTER TABLE workspace_settings ADD CONSTRAINT workspace_settings_starting_model_allowed_check
  CHECK ("defaultModel" IS NULL OR "allowedModels" IS NULL OR "defaultModel" = ANY ("allowedModels"));
COMMIT;
