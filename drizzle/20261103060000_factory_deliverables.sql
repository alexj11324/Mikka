ALTER TABLE factory_candidates ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'repository';
ALTER TABLE factory_candidates ALTER COLUMN sha DROP NOT NULL;
ALTER TABLE factory_candidates DROP CONSTRAINT IF EXISTS factory_candidates_sha_check;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='factory_candidates'::regclass AND conname='factory_candidates_kind_sha_check') THEN
    ALTER TABLE factory_candidates ADD CONSTRAINT factory_candidates_kind_sha_check CHECK
      ((kind IN ('repository','report') AND sha ~ '^[a-f0-9]{40}$' AND sha IS NOT NULL) OR (kind='deliverable' AND sha IS NULL));
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS factory_deliverable_acceptances (
  id uuid PRIMARY KEY, "taskId" uuid NOT NULL REFERENCES factory_tasks(id) ON DELETE CASCADE,
  "candidateId" uuid NOT NULL, "userId" text NOT NULL, "sessionId" text NOT NULL, "eventId" uuid NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("taskId","candidateId"), UNIQUE ("userId","eventId"),
  FOREIGN KEY ("taskId","candidateId") REFERENCES factory_candidates("taskId",id)
);
