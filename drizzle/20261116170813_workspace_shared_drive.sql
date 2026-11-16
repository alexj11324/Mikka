-- target: MIKKA_DATABASE_URL

BEGIN;
SET LOCAL lock_timeout = '5s';

-- The storage principal is not a login. A shared volume and each staged or
-- committed blob have the same canonical workspace owner in every client.
ALTER TABLE "user" ADD CONSTRAINT user_not_team_drive_principal CHECK (id NOT LIKE 'drive-team:%');
ALTER TABLE drive_volumes DROP CONSTRAINT "drive_volumes_driveScope_check",
  ADD CONSTRAINT "drive_volumes_driveScope_check" CHECK ("driveScope" IN ('user','project','project-user','team-workspace')),
  ADD CONSTRAINT drive_volumes_team_owner CHECK (
    ("driveScope" <> 'team-workspace' AND "ownerId" NOT LIKE 'drive-team:%')
    OR ("driveScope"='team-workspace' AND "workspaceId" IS NOT NULL AND
        "scopeId"="workspaceId"::text AND "ownerId"='drive-team:' || "workspaceId"::text));

ALTER TABLE drive_blobs DROP CONSTRAINT drive_blob_project_owner,
  ADD CONSTRAINT drive_blob_shared_owner CHECK (
    ("workspaceId" IS NULL AND "projectId" IS NULL AND "ownerId" NOT LIKE 'drive-project:%' AND "ownerId" NOT LIKE 'drive-team:%')
    OR ("workspaceId" IS NOT NULL AND "projectId" IS NOT NULL AND
        "ownerId"='drive-project:' || "workspaceId"::text || ':' || "projectId"::text AND
        ("storageKey" IS NULL OR "storageKey"='drive/drive-project%3A' || "workspaceId"::text || '%3A' ||
          "projectId"::text || '/' || left(sha256,2) || '/' || sha256))
    OR ("workspaceId" IS NOT NULL AND "projectId" IS NULL AND
        "ownerId"='drive-team:' || "workspaceId"::text AND
        ("storageKey" IS NULL OR "storageKey"='drive/drive-team%3A' || "workspaceId"::text || '/' || left(sha256,2) || '/' || sha256)));

-- As with projectDriveId, the worker keeps this identifier after tenant
-- deletion: it owns a pending object retirement, not a live tenant row.
ALTER TABLE chat_attachment_retirements ADD COLUMN "teamDriveId" uuid,
  DROP CONSTRAINT attachment_retirement_owner,
  ADD CONSTRAINT attachment_retirement_owner CHECK (num_nonnulls("userId","taskId","projectDriveId","teamDriveId")=1);
CREATE FUNCTION retire_team_drive_blob() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO chat_attachment_retirements ("storageKey","teamDriveId") VALUES (OLD."storageKey",OLD."workspaceId")
    ON CONFLICT DO NOTHING;
  RETURN OLD;
END $$;
CREATE TRIGGER retire_team_drive_blob AFTER DELETE ON drive_blobs FOR EACH ROW
  WHEN (OLD."workspaceId" IS NOT NULL AND OLD."projectId" IS NULL AND OLD."storageKey" IS NOT NULL)
  EXECUTE FUNCTION retire_team_drive_blob();
COMMIT;
