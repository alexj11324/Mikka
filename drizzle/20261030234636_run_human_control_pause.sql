-- Human control keeps the claimed run and its existing session in place.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "pauseReason" text;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "resumeStatus" text;
