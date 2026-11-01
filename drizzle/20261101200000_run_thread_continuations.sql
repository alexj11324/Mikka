-- target: MIKKA_DATABASE_URL
-- One task, one thread (decision 2026-11-01-1330-one-thread-per-task): a
-- dispatch to a task that already has a thread continues it. The run that
-- continues an ended thread points at the run it goes on from
-- ("continuesRunId"), so the run chain (lib/run-chain.ts) keeps one thread.
-- A thread the person explicitly replaced keeps a pointer to the thread that
-- replaced it ("threadReplacedBy", on its root run). Additive and nullable;
-- existing rows are not changed.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "continuesRunId" uuid REFERENCES agent_runs(id) ON DELETE SET NULL;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "threadReplacedBy" uuid REFERENCES agent_runs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS agent_runs_continues_run_idx ON agent_runs ("continuesRunId") WHERE "continuesRunId" IS NOT NULL;
