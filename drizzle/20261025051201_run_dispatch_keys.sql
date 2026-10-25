-- target: MIKKA_DATABASE_URL
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "dispatchKey" text;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "dispatchFingerprint" text;

-- Older runs stay unkeyed. A request key is private to its dispatching owner.
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_user_dispatch_key
  ON agent_runs ("userId", "dispatchKey") WHERE "dispatchKey" IS NOT NULL;
