-- Per-thread interaction modes (#1730): plan | execute | ask.
--
-- `agent_runs.mode` freezes what a run was admitted as. Historical rows keep
-- the behavior they had: execute. `task_thread_modes` is the thread-level
-- choice a person transitions explicitly; its `version` fences stale pickers
-- (optimistic concurrency), and admission copies it onto each new run.
--
-- `agent_tool_approvals."decidedBy"` records who answered an Ask request. The
-- approval itself remains one run-bound request; no agent or workspace grant
-- is created here.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'execute';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_runs_mode_check') THEN
    ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_mode_check CHECK (mode IN ('plan', 'execute', 'ask'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS task_thread_modes (
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "issueId" uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'execute' CHECK (mode IN ('plan', 'execute', 'ask')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  "updatedBy" text NOT NULL,
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", "issueId")
);
CREATE INDEX IF NOT EXISTS task_thread_modes_issue ON task_thread_modes ("issueId");

ALTER TABLE agent_tool_approvals ADD COLUMN IF NOT EXISTS "decidedBy" text;
ALTER TABLE agent_tool_approvals ADD COLUMN IF NOT EXISTS tool text;
-- Ask stores an expired request as expired when its decision is attempted;
-- the original check predates that status.
DO $$ BEGIN
  ALTER TABLE agent_tool_approvals DROP CONSTRAINT IF EXISTS agent_tool_approvals_status_check;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_tool_approvals_status_check') THEN
    ALTER TABLE agent_tool_approvals ADD CONSTRAINT agent_tool_approvals_status_check CHECK (status IN ('pending', 'approved', 'denied', 'cancelled', 'expired', 'consumed'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS agent_tool_approvals_run_pending
  ON agent_tool_approvals ("runId", "expiresAt") WHERE status = 'pending';
