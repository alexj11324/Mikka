-- target: MIKKA_DATABASE_URL
-- A run paused because its subscription's quota ran out mid-run
-- ("pauseReason"='quota_exhausted') keeps when the CLI said the quota resets.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "quotaResetsAt" timestamptz;
