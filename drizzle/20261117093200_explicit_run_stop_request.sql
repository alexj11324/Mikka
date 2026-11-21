ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "explicitStopRequested" boolean NOT NULL DEFAULT false;
