-- target: MIKKA_DATABASE_URL

ALTER TABLE cloud_machines ADD COLUMN IF NOT EXISTS "errorCode" text;
