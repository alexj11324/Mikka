-- 模型与订阅 › 优先使用的 Agent (decision 2026-11-02-1700): the Agent a model both
-- Agents can run (a DeepSeek or Kimi key) takes by default. Claude Code unless changed.
ALTER TABLE model_order_settings ADD COLUMN IF NOT EXISTS "preferredHarness" text NOT NULL DEFAULT 'claude_code';
DO $$ BEGIN
  ALTER TABLE model_order_settings ADD CONSTRAINT model_order_settings_preferred_harness CHECK ("preferredHarness" IN ('claude_code', 'codex'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
