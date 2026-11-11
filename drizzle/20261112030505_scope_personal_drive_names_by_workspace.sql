-- target: MIKKA_DATABASE_URL

-- Personal folders belong to their selected workspace. Legacy personal folders
-- outside a workspace still share one namespace, as do all rows of one project
-- scope. Keep the old index until the replacement has been built successfully.
CREATE UNIQUE INDEX IF NOT EXISTS drive_volumes_tenant_scope_name_key
  ON drive_volumes (
    "driveScope", "scopeId", COALESCE("scopeUserId", ''),
    (CASE WHEN "driveScope" = 'user' THEN "workspaceId" END), name
  ) NULLS NOT DISTINCT;

DROP INDEX IF EXISTS drive_volumes_scope_name_key;
