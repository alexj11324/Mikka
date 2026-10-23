-- App database only. Metadata defaults false for existing/old devices; no backfill.
-- Short metadata-only ALTER; normal deployment migration serialization applies.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS "computerUse" jsonb NOT NULL DEFAULT '{"installed":false,"version":null}'::jsonb;
