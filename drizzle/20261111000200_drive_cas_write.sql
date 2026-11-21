-- Drive's compare-and-swap write: one receipt per applied mutation, so a retry
-- lands once and never twice.
--
-- A write carries `expectedDigest`, the tree digest the caller believes is
-- current. The store locks the volume row, compares, and either refuses with a
-- 409 naming the paths that differ or appends a new version and moves the two
-- head pointers. The receipt makes the retry safe: the same `mutationId` with
-- the same body returns the version the first attempt produced, and the same
-- `mutationId` with a different body is refused rather than silently ignored.
--
-- The receipt is keyed by (volume, mutationId) rather than globally: a client
-- only has to keep its ids unique within one volume, and a cross-volume guess
-- cannot collide with another volume's history.

CREATE TABLE IF NOT EXISTS drive_mutations (
  "volumeId" text NOT NULL REFERENCES drive_volumes(id) ON DELETE CASCADE,
  "mutationId" text NOT NULL,
  -- The request's own digest over (expectedDigest, kind, changes). A replay with
  -- the same id must present the same value; anything else is a different write
  -- wearing a used id, which is refused.
  "requestDigest" text NOT NULL,
  -- The version this mutation produced, so a replay answers with the same id.
  "versionId" text NOT NULL,
  -- What the CAS expected and what the tree became. Kept for diagnosis: a
  -- conflict report and a replay both read better with both values present.
  "expectedDigest" text,
  "resultDigest" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("volumeId", "mutationId"),
  CONSTRAINT drive_mutations_id_shape CHECK ("mutationId" ~ '^[A-Za-z0-9._:-]{8,128}$'),
  CONSTRAINT drive_mutations_request_digest_shape CHECK ("requestDigest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT drive_mutations_version_shape CHECK ("versionId" ~ '^vver_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT drive_mutations_expected_digest_shape CHECK ("expectedDigest" IS NULL OR "expectedDigest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT drive_mutations_result_digest_shape CHECK ("resultDigest" ~ '^[a-f0-9]{64}$')
);
CREATE INDEX IF NOT EXISTS drive_mutations_version_idx ON drive_mutations ("versionId");
