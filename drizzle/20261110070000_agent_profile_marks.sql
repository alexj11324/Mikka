-- An Agent Profile's own mark (Alex, 2026-11-10): a glyph and a colour from closed sets.
-- Null on existing rows; readers derive a default from the Profile's roles and name.
ALTER TABLE factory_agent_profiles
  ADD COLUMN IF NOT EXISTS icon text CHECK (icon IS NULL OR icon IN ('square', 'chevrons', 'lens', 'lines', 'check', 'stairs', 'diamond', 'arrow')),
  ADD COLUMN IF NOT EXISTS color text CHECK (color IS NULL OR color IN ('ink', 'graphite', 'teal', 'pink'));
