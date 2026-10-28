-- Execution-question state on the existing application database. No scheduler or new queue.
BEGIN;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "questionContinuation" jsonb;
CREATE TABLE IF NOT EXISTS factory_questions (
  id uuid PRIMARY KEY,
  "userId" text NOT NULL,
  "issueId" uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  "taskId" uuid NOT NULL REFERENCES factory_tasks(id) ON DELETE CASCADE,
  "attemptId" uuid NOT NULL,
  "candidateId" uuid,
  stage text NOT NULL,
  "originRunId" uuid NOT NULL UNIQUE,
  "originSessionId" text NOT NULL,
  "originRevision" integer NOT NULL CHECK ("originRevision">0),
  "waitingBinding" jsonb NOT NULL,
  kind text NOT NULL CHECK (kind IN ('context','decision','permission','external')),
  question text NOT NULL,
  context text NOT NULL DEFAULT '',
  options jsonb NOT NULL DEFAULT '[]',
  request jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('open','waiting_user','answered','resuming','resolved','blocked','cancelled','expired','superseded')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  reason text NOT NULL,
  "sourceEventId" uuid NOT NULL REFERENCES coordinator_events(id),
  "escalationEventId" uuid,
  "escalationRequest" jsonb,
  "answerId" uuid UNIQUE,
  "answerSource" text CHECK ("answerSource" IN ('human','human_event','orchestrator')),
  "answerSourceEventId" uuid UNIQUE,
  answer jsonb,
  "answerFingerprint" text,
  result jsonb,
  "continuationRunId" uuid UNIQUE,
  "expiresAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "answeredAt" timestamptz,
  FOREIGN KEY ("taskId","attemptId") REFERENCES factory_attempts("taskId",id),
  FOREIGN KEY ("taskId","candidateId") REFERENCES factory_candidates("taskId",id)
);
CREATE INDEX IF NOT EXISTS factory_questions_owner_task_idx ON factory_questions("userId","taskId","createdAt");
CREATE INDEX IF NOT EXISTS factory_questions_pending_idx ON factory_questions("userId",status,"createdAt");
COMMIT;
