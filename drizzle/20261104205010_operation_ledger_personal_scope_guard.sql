-- target: DATABASE_URL
BEGIN;
SET LOCAL lock_timeout = '5s';

-- Approved writes use an account-owned ledger scope, not a workspace UUID.
-- Accept only this table's exact owner scope, while retaining the account
-- deletion lock/fence on INSERT and UPDATE. Other scopes keep the UUID guard.
CREATE OR REPLACE FUNCTION mikka_account_guard_workspace_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_data jsonb := to_jsonb(NEW);
  workspace_scope text := row_data->>'workspaceId';
  ledger_owner text := row_data->>'ownerId';
BEGIN
  IF TG_TABLE_NAME = 'operation_ledger'
     AND ledger_owner IS NOT NULL
     AND workspace_scope = 'personal:' || ledger_owner THEN
    PERFORM mikka_account_assert_writable(ledger_owner);
    RETURN NEW;
  END IF;
  IF EXISTS(SELECT 1 FROM account_deletion_workspace_guards WHERE "workspaceId"=workspace_scope::uuid) THEN
    RAISE EXCEPTION 'account_deletion_pending' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

COMMIT;
