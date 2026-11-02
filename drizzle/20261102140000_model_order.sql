-- 模型与订阅 › 允许使用的模型 (decision 2026-11-02-1400): the models a person
-- allows, in the order dispatch tries them, per workspace. Each entry is an
-- Agent and a model of one credential: a connected subscription
-- (byos_connections) or an API key (model_api_keys). No model name is stored
-- that a provider or CLI did not report; the server checks each add against
-- the person's current candidates.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE IF NOT EXISTS model_order_entries (
  id uuid PRIMARY KEY,
  "ownerId" text NOT NULL,
  "workspaceId" uuid NOT NULL,
  position integer NOT NULL,
  harness text NOT NULL CHECK (harness IN ('claude_code', 'codex')),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 128),
  "sourceKind" text NOT NULL CHECK ("sourceKind" IN ('subscription', 'api_key')),
  "sourceId" uuid NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS model_order_entries_unique ON model_order_entries ("ownerId", "workspaceId", harness, model, "sourceId");
CREATE INDEX IF NOT EXISTS model_order_entries_order ON model_order_entries ("ownerId", "workspaceId", position);
-- 运行位置 (云端 / 本地), and whether the person has changed the list: an
-- untouched list is filled from the default preference at read time.
CREATE TABLE IF NOT EXISTS model_order_settings (
  "ownerId" text NOT NULL,
  "workspaceId" uuid NOT NULL,
  location text NOT NULL DEFAULT 'local' CHECK (location IN ('cloud', 'local')),
  customized boolean NOT NULL DEFAULT false,
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("ownerId", "workspaceId")
);
-- 参与调度 is now the device's one switch (devices.enabled). A device used to
-- take automatic runs only with 允许调度 and 允许自动调度 both on; one whose
-- owner had turned 允许自动调度 off keeps out. Unset now means it takes part.
UPDATE devices SET enabled = false WHERE kind = 'local' AND enabled AND "autoSchedule" = false;
COMMIT;
