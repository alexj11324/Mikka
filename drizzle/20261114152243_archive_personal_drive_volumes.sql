-- target: MIKKA_DATABASE_URL

ALTER TABLE drive_volumes ADD COLUMN IF NOT EXISTS "archivedAt" timestamptz;
