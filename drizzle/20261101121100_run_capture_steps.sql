-- Recording timeline (Figma 13): when ffmpeg actually began, and each step the
-- agent described while it recorded, as an offset from that moment.
ALTER TABLE run_captures ADD COLUMN IF NOT EXISTS "startedAt" timestamptz;
CREATE TABLE IF NOT EXISTS run_capture_steps (
  id uuid PRIMARY KEY,
  "captureId" uuid NOT NULL REFERENCES run_captures(id) ON DELETE CASCADE,
  "userId" text NOT NULL,
  "atMs" integer NOT NULL CHECK ("atMs" >= 0),
  label varchar(200) NOT NULL,
  source text NOT NULL CHECK (source IN ('action','mark')),
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS run_capture_steps_capture_idx ON run_capture_steps ("captureId", "atMs");
