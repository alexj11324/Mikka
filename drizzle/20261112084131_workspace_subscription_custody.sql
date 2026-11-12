-- target: DATABASE_URL
BEGIN;
SET LOCAL lock_timeout = '5s';
-- The APP migration defines this installer only in the store that owns BYOS.
-- The historical Workspace inventory has now run on fresh single-store installs.
DO $$ BEGIN
  IF to_regprocedure('mikka_install_account_byos_cleanup_guards()') IS NOT NULL THEN
    PERFORM mikka_install_account_byos_cleanup_guards();
  END IF;
END $$;
COMMIT;
