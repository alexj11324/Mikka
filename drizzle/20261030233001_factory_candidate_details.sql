-- Delivery metadata is a snapshot from the producing run, not a live device lookup.
ALTER TABLE factory_candidates ADD COLUMN IF NOT EXISTS "previewDatabaseBranch" text;
ALTER TABLE factory_candidates ADD COLUMN IF NOT EXISTS "machineName" text;
