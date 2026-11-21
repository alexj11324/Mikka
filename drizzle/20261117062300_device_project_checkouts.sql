-- target: MIKKA_DATABASE_URL
CREATE TABLE IF NOT EXISTS device_project_checkouts (
  "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "workspaceId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "deviceId" uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  "resourceKind" text NOT NULL DEFAULT 'project' CHECK ("resourceKind" = 'project'),
  root varchar(1024) NOT NULL CHECK (length(root) > 0),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("ownerId", "workspaceId", "projectId", "deviceId"),
  FOREIGN KEY ("resourceKind", "projectId") REFERENCES resource_access_policies(kind,id) ON DELETE CASCADE
);

-- Device removal keeps a tombstone for run history. Delete the bookmark in
-- the same transaction, including removals performed by a pre-migration app.
CREATE OR REPLACE FUNCTION mikka_purge_device_project_checkouts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM device_project_checkouts WHERE "deviceId" = NEW.id;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER mikka_device_project_checkouts_removed
  AFTER UPDATE OF "removedAt" ON devices
  FOR EACH ROW WHEN (OLD."removedAt" IS NULL AND NEW."removedAt" IS NOT NULL)
  EXECUTE FUNCTION mikka_purge_device_project_checkouts();
