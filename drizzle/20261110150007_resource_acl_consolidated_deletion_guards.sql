-- target: DATABASE_URL
-- In self-hosted/consolidated databases the historical Workspace inventory
-- runs after APP migrations. Replace its generic owner/content treatment of
-- these exact ACL tables with 20011's authority-specific deletion guard.
-- Split DB Workspace targets contain none of these tables and are untouched.
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='resource_access_events') THEN
    DROP TRIGGER IF EXISTS account_deletion_insert_guard ON resource_access_events;
    DROP TRIGGER IF EXISTS account_deletion_workspace_guard ON resource_access_events;
  END IF;
  IF EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='resource_access_policies') THEN
    DROP TRIGGER IF EXISTS account_deletion_insert_guard ON resource_access_policies;
    DROP TRIGGER IF EXISTS account_deletion_workspace_guard ON resource_access_policies;
  END IF;
END;
$$;
