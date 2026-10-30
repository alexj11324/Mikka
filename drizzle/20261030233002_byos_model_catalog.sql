-- target: MIKKA_DATABASE_URL
-- Last successful provider catalogue. Bindings referenced by runs/choices remain intact.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE byos_connections ADD COLUMN IF NOT EXISTS "modelCatalog" jsonb;
COMMIT;
