-- target: MIKKA_DATABASE_URL
-- Host-owned CI continuation metadata; it never grants permissions itself.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "ciContinuation" jsonb;
