-- target: MIKKA_DATABASE_URL

-- Missed index: nothing on agent_runs led with status, yet the due timer asks
-- which leases expire (RUN_RECOVERY_DUE_SQL in lib/run-recovery-due.ts) and both
-- lease sweeps ask the same of lost runs (lib/run-leases.ts), filtering on
-- status and "leaseExpiresAt". run_publications already carries the same index
-- for its own pending sweep. A composite index rather than a partial one: the
-- query passes a parameterised text[] of statuses, so the planner cannot prove
-- the predicate implies a constant list. Mirrors lib/db/schema.ts. Safe to run
-- again.
CREATE INDEX IF NOT EXISTS agent_runs_status_lease_idx ON agent_runs (status, "leaseExpiresAt");
