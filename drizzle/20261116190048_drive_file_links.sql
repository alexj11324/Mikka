-- target: MIKKA_DATABASE_URL

-- A link names a live file, never its bytes, credentials or immutable versions.
-- Removing and later restoring that path must not resurrect its old links.
CREATE TABLE IF NOT EXISTS drive_file_links (
  id uuid PRIMARY KEY,
  "volumeId" text NOT NULL,
  path text NOT NULL,
  "createdBy" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'org')),
  FOREIGN KEY ("volumeId", path) REFERENCES drive_volume_entries ("volumeId", path) ON DELETE CASCADE,
  UNIQUE ("volumeId", path, "createdBy")
);
CREATE INDEX IF NOT EXISTS drive_file_links_creator_idx ON drive_file_links ("createdBy");
