ALTER TABLE devices ADD COLUMN IF NOT EXISTS "computerUse" jsonb NOT NULL DEFAULT '{"installed":false,"version":null}'::jsonb;
