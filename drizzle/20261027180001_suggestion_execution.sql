-- A click is persisted atomically with its Coordinator inbox event.
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS "executionState" text NOT NULL DEFAULT 'not_started'
  CHECK ("executionState" IN ('not_started', 'running', 'completed', 'failed'));
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS "executionStartedAt" timestamptz;
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS "executionFinishedAt" timestamptz;
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS "executionRunId" uuid REFERENCES agent_runs(id) ON DELETE SET NULL;
ALTER TABLE suggestions ADD COLUMN IF NOT EXISTS "executionSubagentId" uuid REFERENCES bot_subagents(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS suggestions_execution_run_idx ON suggestions("executionRunId") WHERE "executionRunId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS suggestions_execution_subagent_idx ON suggestions("executionSubagentId") WHERE "executionSubagentId" IS NOT NULL;
