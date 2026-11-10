-- target: DATABASE_URL
-- #1849: model policy extends the existing Organization governance authority.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE mikka_organization_resource_policies ADD COLUMN IF NOT EXISTS "modelPolicy" jsonb;
COMMIT;
