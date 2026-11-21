-- target: MIKKA_DATABASE_URL

-- Physical deduplication remains owner + digest. A tenant-scoped API token may
-- refer to those bytes only after an upload in its own verified Workspace.
-- Do not backfill admissions from owner identity or knowledge of a digest.
CREATE TABLE IF NOT EXISTS drive_blob_admissions (
  "ownerId" text NOT NULL,
  sha256 text NOT NULL,
  "workspaceId" uuid NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("ownerId", sha256, "workspaceId"),
  FOREIGN KEY ("ownerId", sha256) REFERENCES drive_blobs("ownerId", sha256) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS drive_blob_admissions_workspace_idx ON drive_blob_admissions("workspaceId");

DROP TRIGGER IF EXISTS account_deletion_insert_guard ON drive_blob_admissions;
CREATE TRIGGER account_deletion_insert_guard BEFORE INSERT ON drive_blob_admissions
  FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_insert('ownerId');
