-- Drive: a person's or a project's file tree, addressed by content.
--
-- This is not a repository checkout and not the coding-workspace file view;
-- those describe work a run did in a repo. A volume is the unit that holds one
-- tree, and it is written only through a compare-and-swap on its tree digest
-- (the write path lands in 20261111000200_drive_cas_write.sql).
--
-- Ids are prefixed ULIDs, not uuids: `vol_` for a volume, `vver_` for a version.
-- A prefixed id says what it names wherever a log line or a tool call shows it,
-- and a text column is what lets the prefix exist at all.

CREATE TABLE IF NOT EXISTS drive_volumes (
  id text PRIMARY KEY,
  -- Which layer of Drive this volume belongs to. `workspace` is deliberately
  -- NOT reused here: it already means the tenant, and a volume's scope is not a
  -- tenant. `user` is one person, `project` is one project, `project-user` is
  -- one person's own Drive inside a project.
  "driveScope" text NOT NULL CHECK ("driveScope" IN ('user', 'project', 'project-user')),
  -- What the scope names: the owner's user id, or the project id.
  "scopeId" text NOT NULL,
  -- The person inside a `project-user` volume; NULL for every other scope.
  "scopeUserId" text,
  "ownerId" text NOT NULL,
  -- Immutable tenant. NULL only for a personal volume outside any workspace.
  "workspaceId" uuid,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- The two head pointers. They move together, in one statement, so a reader
  -- never sees a digest that does not belong to the version it names.
  "headVersionId" text NOT NULL,
  "headDigest" text NOT NULL,
  -- The head's size, kept on the volume so a quota check needs no manifest read.
  "entryCount" integer NOT NULL DEFAULT 0,
  "totalBytes" bigint NOT NULL DEFAULT 0,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  -- The id shape is the contract, so the database refuses anything else even
  -- when a caller builds an id by hand.
  CONSTRAINT drive_volumes_id_shape CHECK (id ~ '^vol_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT drive_volumes_head_version_shape CHECK ("headVersionId" ~ '^vver_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT drive_volumes_head_digest_shape CHECK ("headDigest" ~ '^[a-f0-9]{64}$'),
  -- 100 000 entries is the tree ceiling; a volume can never report more.
  CONSTRAINT drive_volumes_entry_count_bounds CHECK ("entryCount" BETWEEN 0 AND 100000),
  CONSTRAINT drive_volumes_total_bytes_bounds CHECK ("totalBytes" >= 0),
  -- A person's own volume names its person; a project-user volume names both.
  CONSTRAINT drive_volumes_scope_shape CHECK (("driveScope" <> 'project-user') = ("scopeUserId" IS NULL))
);
-- One name per scope: two volumes called "notes" under one person would make a
-- name lookup ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS drive_volumes_scope_name_key
  ON drive_volumes ("driveScope", "scopeId", COALESCE("scopeUserId", ''), name);
CREATE INDEX IF NOT EXISTS drive_volumes_owner_idx ON drive_volumes ("ownerId", "updatedAt" DESC);
CREATE INDEX IF NOT EXISTS drive_volumes_scope_idx ON drive_volumes ("driveScope", "scopeId", "updatedAt" DESC);

-- One person's content, by digest. Deduplicated WITHIN an owner, never across
-- owners: the digest is public by nature (a client sends it), so a blob keyed by
-- digest alone would let one person name another person's digest and read their
-- bytes. Keying by (owner, digest) keeps the saving and closes that hole.
CREATE TABLE IF NOT EXISTS drive_blobs (
  "ownerId" text NOT NULL,
  sha256 text NOT NULL,
  "sizeBytes" integer NOT NULL,
  -- Object key in the object-storage bucket, or the bytes themselves where no
  -- bucket is configured (previews, community installs, tests).
  "storageKey" text,
  "inlineContent" bytea,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("ownerId", sha256),
  CONSTRAINT drive_blobs_digest_shape CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  -- 0-byte files are legal; 100 MiB is the ceiling, and it is inclusive.
  CONSTRAINT drive_blobs_size_bounds CHECK ("sizeBytes" BETWEEN 0 AND 104857600),
  -- Exactly one home for the bytes, so a read never has to guess.
  CONSTRAINT drive_blobs_home CHECK (("storageKey" IS NULL) <> ("inlineContent" IS NULL))
);
-- The storage key embeds the owner as well, so two people storing the same bytes
-- never share one object whose deletion would break the other's volume.
CREATE UNIQUE INDEX IF NOT EXISTS drive_blobs_storage_key ON drive_blobs ("storageKey") WHERE "storageKey" IS NOT NULL;

-- The head tree, one row per path. This is the readable, diffable form of the
-- manifest: a CAS write compares digests, then adds/removes exactly these rows.
CREATE TABLE IF NOT EXISTS drive_volume_entries (
  "volumeId" text NOT NULL REFERENCES drive_volumes(id) ON DELETE CASCADE,
  path text NOT NULL,
  -- 420 = 0o644, 493 = 0o755. Only those two, as the tree contract states.
  mode integer NOT NULL,
  "sizeBytes" integer NOT NULL,
  sha256 text NOT NULL,
  PRIMARY KEY ("volumeId", path),
  CONSTRAINT drive_volume_entries_mode_allowed CHECK (mode IN (420, 493)),
  CONSTRAINT drive_volume_entries_size_bounds CHECK ("sizeBytes" BETWEEN 0 AND 104857600),
  CONSTRAINT drive_volume_entries_digest_shape CHECK (sha256 ~ '^[a-f0-9]{64}$')
);
-- Find which volumes hold given content, for reference counting and cleanup.
CREATE INDEX IF NOT EXISTS drive_volume_entries_blob_idx ON drive_volume_entries (sha256);
-- A volume's owner, denormalised onto its entries so a CAS can prove every put
-- names a blob its own owner stored, without joining on every row.
ALTER TABLE drive_volume_entries ADD COLUMN IF NOT EXISTS "ownerId" text;
UPDATE drive_volume_entries e SET "ownerId"=v."ownerId" FROM drive_volumes v WHERE v.id=e."volumeId" AND e."ownerId" IS NULL;
ALTER TABLE drive_volume_entries ALTER COLUMN "ownerId" SET NOT NULL;

-- An immutable version: what the tree was, who changed it and in which thread.
-- Nothing here is ever updated; a restore adds a version rather than moving a
-- pointer back, so an earlier state is never lost.
CREATE TABLE IF NOT EXISTS drive_volume_versions (
  id text PRIMARY KEY,
  "volumeId" text NOT NULL REFERENCES drive_volumes(id) ON DELETE CASCADE,
  -- Repeated from the volume so the owner sweep below and account deletion find
  -- this row by its owner column, like every other owner-scoped table.
  "ownerId" text NOT NULL,
  -- 1-based and contiguous per volume, so a history list orders without a count.
  seq integer NOT NULL,
  -- `autosave` is an ordinary write, `checkpoint` a named one, `restore` the
  -- new version a restore creates.
  kind text NOT NULL CHECK (kind IN ('autosave', 'checkpoint', 'restore')),
  "fileCount" integer NOT NULL,
  "totalBytes" bigint NOT NULL,
  digest text NOT NULL,
  -- The full tree at this version, so history and restore need no replay.
  manifest jsonb NOT NULL,
  -- The audit trail: which thread and which author made this version. A Drive
  -- history is read as "which thread changed this", and a restore needs to know
  -- whose work it is re-applying.
  "threadId" text,
  "threadTitle" text,
  "authorName" text NOT NULL,
  -- The restore source, for a `restore` version only.
  "restoredFromVersionId" text REFERENCES drive_volume_versions(id) ON DELETE SET NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drive_volume_versions_id_shape CHECK (id ~ '^vver_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT drive_volume_versions_seq_positive CHECK (seq >= 1),
  CONSTRAINT drive_volume_versions_digest_shape CHECK (digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT drive_volume_versions_file_count_bounds CHECK ("fileCount" BETWEEN 0 AND 100000),
  CONSTRAINT drive_volume_versions_total_bytes_bounds CHECK ("totalBytes" >= 0),
  -- Only a restore names a source, and a restore always does.
  CONSTRAINT drive_volume_versions_restore_shape CHECK ((kind = 'restore') = ("restoredFromVersionId" IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS drive_volume_versions_seq_key ON drive_volume_versions ("volumeId", seq);
CREATE INDEX IF NOT EXISTS drive_volume_versions_volume_created_idx
  ON drive_volume_versions ("volumeId", "createdAt" DESC, id DESC);
CREATE INDEX IF NOT EXISTS drive_volume_versions_owner_idx ON drive_volume_versions ("ownerId", "createdAt" DESC);

-- A closing account cannot add a volume or a version after its sweep starts,
-- matching every other owner-scoped table.
DROP TRIGGER IF EXISTS account_deletion_insert_guard ON drive_volumes;
CREATE TRIGGER account_deletion_insert_guard BEFORE INSERT ON drive_volumes
  FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_insert('ownerId');
DROP TRIGGER IF EXISTS account_deletion_insert_guard ON drive_volume_versions;
CREATE TRIGGER account_deletion_insert_guard BEFORE INSERT ON drive_volume_versions
  FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_insert('ownerId');
