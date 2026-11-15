-- target: MIKKA_DATABASE_URL

-- Earlier daemons retain their original signed Skill report or no observation.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "observedModel" varchar(500);
