-- target: MIKKA_DATABASE_URL
CREATE TABLE IF NOT EXISTS task_attachments (
  "taskId" uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  name text NOT NULL,
  size integer NOT NULL CHECK (size BETWEEN 1 AND 3145728),
  sha256 text NOT NULL,
  "storageKey" text,
  "inlineData" bytea,
  "userId" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("taskId",id),
  CHECK (num_nonnulls("storageKey","inlineData") = 1)
);

-- The existing object retirement worker processes private task files as well.
-- This also covers cascades when the owning task is permanently removed.
ALTER TABLE chat_attachment_retirements
  ADD COLUMN IF NOT EXISTS "taskId" uuid,
  ALTER COLUMN "userId" DROP NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='chat_attachment_retirements'::regclass AND conname='attachment_retirement_owner') THEN
    ALTER TABLE chat_attachment_retirements ADD CONSTRAINT attachment_retirement_owner
      CHECK (num_nonnulls("userId","taskId") = 1);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION retire_task_attachment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."storageKey" IS NOT NULL THEN
    INSERT INTO chat_attachment_retirements("storageKey","taskId") VALUES(OLD."storageKey",OLD."taskId") ON CONFLICT DO NOTHING;
  END IF;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS retire_task_attachment_files ON task_attachments;
CREATE TRIGGER retire_task_attachment_files AFTER DELETE ON task_attachments FOR EACH ROW EXECUTE FUNCTION retire_task_attachment();
