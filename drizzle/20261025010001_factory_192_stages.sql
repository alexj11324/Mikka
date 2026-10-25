-- Factory #192: application database only. No new scheduler or dispatch queue.
BEGIN;
CREATE TABLE IF NOT EXISTS factory_tasks (
  id uuid PRIMARY KEY, "userId" text NOT NULL,
  "issueId" uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  "sourceEventId" uuid NOT NULL REFERENCES coordinator_events(id),
  route jsonb NOT NULL, stage text NOT NULL,
  status text NOT NULL, revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  "attemptId" uuid NOT NULL, "candidateId" uuid,
  reason text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("userId", "issueId", "sourceEventId"),
  CHECK (stage IN ('clarify','spec','execute','review','verify','approval','publish','monitor')),
  CHECK (status IN ('pending','running','waiting','passed','failed','blocked','cancelled','revoked'))
);
CREATE TABLE IF NOT EXISTS factory_candidates (
  id uuid PRIMARY KEY, "taskId" uuid NOT NULL REFERENCES factory_tasks(id) ON DELETE CASCADE,
  sha text NOT NULL CHECK (sha ~ '^[a-f0-9]{40}$'), repository text NOT NULL,
  environment text NOT NULL, scope text NOT NULL,
  "runId" uuid NOT NULL REFERENCES agent_runs(id), "createdAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("taskId", id)
);
CREATE TABLE IF NOT EXISTS factory_attempts (
  id uuid PRIMARY KEY, "taskId" uuid NOT NULL REFERENCES factory_tasks(id) ON DELETE CASCADE,
  stage text NOT NULL, ordinal integer NOT NULL CHECK (ordinal > 0), position integer NOT NULL CHECK (position > 0), status text NOT NULL,
  "candidateId" uuid, "runId" uuid REFERENCES agent_runs(id), "sessionId" text,
  reason text NOT NULL, output jsonb NOT NULL DEFAULT '{}', evidence jsonb NOT NULL DEFAULT '[]',
  "createdAt" timestamptz NOT NULL DEFAULT now(), "finishedAt" timestamptz,
  UNIQUE ("taskId", stage, ordinal), UNIQUE ("taskId", position), UNIQUE ("taskId", id),
  FOREIGN KEY ("taskId", "candidateId") REFERENCES factory_candidates("taskId", id),
  CHECK (stage IN ('clarify','spec','execute','review','verify','approval','publish','monitor')),
  CHECK (status IN ('pending','running','waiting','passed','failed','blocked','cancelled','revoked'))
);
-- Idempotent re-application, including after a committed migration before migration ledger write.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='factory_tasks'::regclass AND conname='factory_tasks_attempt_fk') THEN
    ALTER TABLE factory_tasks ADD CONSTRAINT factory_tasks_attempt_fk FOREIGN KEY (id,"attemptId") REFERENCES factory_attempts("taskId",id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='factory_tasks'::regclass AND conname='factory_tasks_candidate_fk') THEN
    ALTER TABLE factory_tasks ADD CONSTRAINT factory_tasks_candidate_fk FOREIGN KEY (id,"candidateId") REFERENCES factory_candidates("taskId",id);
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS factory_events (
  "taskId" uuid NOT NULL REFERENCES factory_tasks(id) ON DELETE CASCADE, "eventId" uuid NOT NULL,
  request jsonb NOT NULL, result jsonb NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("taskId", "eventId")
);
CREATE INDEX IF NOT EXISTS factory_tasks_owner_issue_idx ON factory_tasks("userId","issueId","updatedAt");
CREATE INDEX IF NOT EXISTS factory_attempts_run_idx ON factory_attempts("runId");
CREATE UNIQUE INDEX IF NOT EXISTS factory_attempts_one_run_key ON factory_attempts("runId") WHERE "runId" IS NOT NULL;
COMMIT;
