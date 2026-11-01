-- target: MIKKA_DATABASE_URL
-- How a run that ended came out (done, blocked, needs_input, failed, idle), as
-- the decision model judged it from its last reply, status, task and PRs; the
-- right column groups threads by it (docs/design/rules.md R-52).
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS outcome text;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "outcomeDecidedBy" text;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "outcomeReason" text;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "outcomeAt" timestamptz;
-- The minute sweep reads ended runs still waiting for a judgment.
CREATE INDEX IF NOT EXISTS agent_runs_outcome_pending_idx ON agent_runs ("finishedAt")
  WHERE outcome IS NULL AND status IN ('succeeded', 'stopped', 'failed', 'cancelled');
