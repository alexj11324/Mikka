-- target: MIKKA_DATABASE_URL

BEGIN;
SET LOCAL lock_timeout = '5s';

-- This reserved storage principal names one project in one tenant. It is never
-- a login or a member, and existing personal volumes keep their current owner.
ALTER TABLE "user" ADD CONSTRAINT user_not_project_drive_principal
  CHECK (id NOT LIKE 'drive-project:%');
ALTER TABLE drive_blobs ADD COLUMN "workspaceId" uuid, ADD COLUMN "projectId" uuid;
ALTER TABLE drive_blobs ADD CONSTRAINT drive_blob_project_owner CHECK (
  ("workspaceId" IS NULL AND "projectId" IS NULL AND "ownerId" NOT LIKE 'drive-project:%')
  OR ("workspaceId" IS NOT NULL AND "projectId" IS NOT NULL AND
      "ownerId" = 'drive-project:' || "workspaceId"::text || ':' || "projectId"::text AND
      ("storageKey" IS NULL OR "storageKey" = 'drive/drive-project%3A' || "workspaceId"::text || '%3A' ||
        "projectId"::text || '/' || left(sha256,2) || '/' || sha256)));
CREATE INDEX drive_blobs_project_workspace ON drive_blobs ("workspaceId") WHERE "workspaceId" IS NOT NULL;

-- Older storage callers could create a project-scoped volume owned by one
-- account. Its private name must not collide with the new shared namespace.
-- For all non-project scopes ownerId is already determined by the scope.
CREATE UNIQUE INDEX drive_volumes_storage_scope_name_key ON drive_volumes (
  "driveScope", "scopeId", COALESCE("scopeUserId",''),
  (CASE WHEN "driveScope"='user' THEN "workspaceId" END),
  (CASE WHEN "driveScope"='project' THEN "ownerId" END), name
) NULLS NOT DISTINCT;
DROP INDEX drive_volumes_tenant_scope_name_key;

-- The same durable worker already retires chat and task objects. The tenant
-- sweep removes project-owned blobs, including staged uploads and old versions.
ALTER TABLE chat_attachment_retirements ADD COLUMN "projectDriveId" uuid,
  DROP CONSTRAINT attachment_retirement_owner;
ALTER TABLE chat_attachment_retirements ADD CONSTRAINT attachment_retirement_owner
  CHECK (num_nonnulls("userId","taskId","projectDriveId") = 1);
CREATE FUNCTION retire_project_drive_blob() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO chat_attachment_retirements ("storageKey","projectDriveId")
    VALUES (OLD."storageKey",OLD."projectId") ON CONFLICT DO NOTHING;
  RETURN OLD;
END $$;
CREATE TRIGGER retire_project_drive_blob AFTER DELETE ON drive_blobs FOR EACH ROW
  WHEN (OLD."projectId" IS NOT NULL AND OLD."storageKey" IS NOT NULL)
  EXECUTE FUNCTION retire_project_drive_blob();
COMMIT;
