-- target: MIKKA_DATABASE_URL
-- New daemons receive run credentials at claim and execute directly. Keep the
-- rolling-release distinction in the existing claim row, without extra reads.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "machineAuthority" boolean NOT NULL DEFAULT false;
