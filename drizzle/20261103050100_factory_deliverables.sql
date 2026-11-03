-- Add report/deliverable identity and browser-owned acceptance without a merge.
BEGIN;
ALTER TABLE factory_candidates ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'code' CHECK (kind IN ('code','report','deliverable'));
ALTER TABLE factory_candidates DROP CONSTRAINT IF EXISTS factory_candidates_sha_check;
ALTER TABLE factory_candidates ADD CONSTRAINT factory_candidates_sha_check CHECK ((kind='deliverable' AND sha='no-repository') OR (kind<>'deliverable' AND sha ~ '^[a-f0-9]{40}$'));
CREATE TABLE IF NOT EXISTS factory_acceptances (
  id uuid PRIMARY KEY, "taskId" uuid NOT NULL REFERENCES factory_tasks(id) ON DELETE CASCADE,
  "candidateId" uuid NOT NULL, "userId" text NOT NULL, "humanSessionId" text NOT NULL,
  revision integer NOT NULL, "eventId" uuid NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY ("taskId","candidateId") REFERENCES factory_candidates("taskId",id),
  UNIQUE ("taskId","eventId"), UNIQUE ("taskId","candidateId")
);
COMMIT;
