-- Agent Profile colours are all chromatic (Alex, 2026-11-20): white and grey read as "not working".
-- The set becomes blue, teal, emerald, violet and pink. Existing rows keep a colour of their own:
-- ink becomes blue and graphite becomes violet. Null still means "derive a default".
-- The check still admits ink and graphite so an older writer during the deploy does not fail a save;
-- readers map them (resolveProfileMark in lib/factory/agent-profile-mark.ts).
ALTER TABLE factory_agent_profiles DROP CONSTRAINT IF EXISTS factory_agent_profiles_color_check;

UPDATE factory_agent_profiles SET color = CASE color WHEN 'ink' THEN 'blue' WHEN 'graphite' THEN 'violet' END
WHERE color IN ('ink', 'graphite');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'factory_agent_profiles'::regclass AND conname = 'factory_agent_profiles_color_check') THEN
    ALTER TABLE factory_agent_profiles ADD CONSTRAINT factory_agent_profiles_color_check
      CHECK (color IS NULL OR color IN ('blue', 'teal', 'emerald', 'violet', 'pink', 'ink', 'graphite'));
  END IF;
END $$;
