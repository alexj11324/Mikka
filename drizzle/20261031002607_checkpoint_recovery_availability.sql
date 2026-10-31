-- A known failed snapshot must replace an older usable snapshot; otherwise a
-- takeover could silently restore work the lost device had already superseded.
ALTER TABLE run_checkpoints ADD COLUMN IF NOT EXISTS "unavailableReason" text;
