-- Record who answered a run-bound tool-approval request, and which tool it
-- named. The approval itself remains one run-bound request: no agent or
-- workspace grant is created here, and nothing is stored per task.
--
-- `"decidedBy"` is the person who made the decision, so an approval surface
-- can say who allowed a risky call and the audit row has a subject.
-- `tool` was already carried by the request protocol; the column is new.
ALTER TABLE agent_tool_approvals ADD COLUMN IF NOT EXISTS "decidedBy" text;
ALTER TABLE agent_tool_approvals ADD COLUMN IF NOT EXISTS tool text;

-- A decision attempted after the request's TTL stores `expired` instead of
-- rewriting the answer; the original check predates that status.
DO $$ BEGIN
  ALTER TABLE agent_tool_approvals DROP CONSTRAINT IF EXISTS agent_tool_approvals_status_check;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_tool_approvals_status_check') THEN
    ALTER TABLE agent_tool_approvals ADD CONSTRAINT agent_tool_approvals_status_check CHECK (status IN ('pending', 'approved', 'denied', 'cancelled', 'expired', 'consumed'));
  END IF;
END $$;

-- A run's pending request is the one a gate waits on; never scan its history.
CREATE INDEX IF NOT EXISTS agent_tool_approvals_run_pending
  ON agent_tool_approvals ("runId", "expiresAt") WHERE status = 'pending';
