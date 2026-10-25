-- #195 consumes existing authorized events; these are observations, not stage state or a worker.
BEGIN;
CREATE TABLE IF NOT EXISTS factory_monitor_incidents (
  id uuid PRIMARY KEY, "userId" text NOT NULL, "workspaceKey" text NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  "checkKey" text NOT NULL CHECK ("checkKey" ~ '^[a-f0-9]{64}$'),
  "issueId" uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  "taskId" uuid NOT NULL REFERENCES factory_tasks(id) ON DELETE CASCADE,
  "candidateId" uuid NOT NULL REFERENCES factory_candidates(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','recovered')),
  occurrences integer NOT NULL DEFAULT 0 CHECK (occurrences >= 0),
  "recoveredObservationId" uuid,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("userId","workspaceKey",fingerprint)
);
CREATE TABLE IF NOT EXISTS factory_monitor_observations (
  id uuid PRIMARY KEY, "userId" text NOT NULL, "workspaceKey" text NOT NULL,
  -- Historical event/run/session identity survives run deletion; revalidate before passing.
  "sourceEventId" uuid NOT NULL, "runId" uuid NOT NULL, "sessionId" text NOT NULL,
  "taskId" uuid NOT NULL REFERENCES factory_tasks(id) ON DELETE CASCADE,
  "candidateId" uuid NOT NULL REFERENCES factory_candidates(id),
  "incidentId" uuid REFERENCES factory_monitor_incidents(id) ON DELETE SET NULL,
  "checkKey" text NOT NULL, request jsonb NOT NULL, evidence jsonb NOT NULL, result jsonb NOT NULL DEFAULT '{}',
  outcome text NOT NULL CHECK (outcome IN ('failed','passed','blocked')),
  deliveries integer NOT NULL DEFAULT 1 CHECK (deliveries > 0),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("userId","sourceEventId")
);
CREATE INDEX IF NOT EXISTS factory_monitor_open_check_idx
  ON factory_monitor_incidents ("userId","workspaceKey","checkKey") WHERE status='open';
COMMIT;
