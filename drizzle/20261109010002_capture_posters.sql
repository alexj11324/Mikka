-- Derived private images, never independently shared evidence. Old videos
-- acquire a poster on their first authenticated request; originals stay intact.
CREATE TABLE IF NOT EXISTS run_capture_posters (
  "captureId" uuid PRIMARY KEY REFERENCES run_captures(id) ON DELETE CASCADE,
  "captureSha256" text NOT NULL CHECK ("captureSha256" ~ '^[a-f0-9]{64}$'),
  "storageKey" text NOT NULL,
  "inlineContent" bytea,
  size integer NOT NULL CHECK (size > 0 AND size <= 256000),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
