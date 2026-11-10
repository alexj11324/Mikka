-- target: MIKKA_DATABASE_URL
-- A run reads only the environment revision frozen for it, never a live row
-- from the workspace database. The snapshot is the complete config a claim or
-- an action needs; environment definitions stay in DATABASE_URL.
CREATE TABLE IF NOT EXISTS run_environment_bindings (
  "runId" uuid PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  "ownerId" text NOT NULL,
  "workspaceId" uuid NOT NULL,
  "environmentId" uuid NOT NULL,
  revision integer NOT NULL,
  snapshot jsonb NOT NULL,
  "frozenAt" timestamptz NOT NULL DEFAULT now(),
  CHECK (revision > 0),
  CHECK (jsonb_typeof(snapshot) = 'object')
);
CREATE INDEX IF NOT EXISTS run_environment_bindings_workspace_idx
  ON run_environment_bindings ("workspaceId", "frozenAt" DESC);

-- One user-triggered command against a run's task machine. Bounded output is
-- stored for history; the runner is separate from the Agent's own tool steps.
CREATE TABLE IF NOT EXISTS run_action_executions (
  id uuid PRIMARY KEY,
  "runId" uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  "ownerId" text NOT NULL,
  "workspaceId" uuid NOT NULL,
  "environmentId" uuid NOT NULL,
  "environmentRevision" integer NOT NULL,
  "actionId" uuid NOT NULL,
  "actionName" varchar(40) NOT NULL,
  "actionKind" text NOT NULL CHECK ("actionKind" IN ('run','dev','test','build')),
  command text NOT NULL,
  cwd text NOT NULL,
  "timeoutSeconds" integer NOT NULL CHECK ("timeoutSeconds" BETWEEN 5 AND 900),
  status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled','timed_out')),
  "exitCode" integer,
  stdout text NOT NULL DEFAULT '',
  stderr text NOT NULL DEFAULT '',
  truncated boolean NOT NULL DEFAULT false,
  "errorCode" text,
  "sandboxId" text,
  pid integer,
  "requestKey" uuid,
  "requestedBy" text NOT NULL,
  "cancelRequestedAt" timestamptz,
  "startedAt" timestamptz,
  "finishedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(command) <= 8000),
  CHECK (octet_length(stdout) <= 65536 AND octet_length(stderr) <= 65536)
);
-- Idempotent retry of one request; different work must use a new key.
CREATE UNIQUE INDEX IF NOT EXISTS run_action_executions_request_key
  ON run_action_executions ("runId", "requestKey") WHERE "requestKey" IS NOT NULL;
-- One running command per run: a second one fails instead of racing the first.
CREATE UNIQUE INDEX IF NOT EXISTS run_action_executions_active
  ON run_action_executions ("runId") WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS run_action_executions_run_idx
  ON run_action_executions ("runId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS run_action_executions_workspace_idx
  ON run_action_executions ("workspaceId", "environmentId", "createdAt" DESC);

DROP TRIGGER IF EXISTS account_deletion_insert_guard ON run_environment_bindings;
CREATE TRIGGER account_deletion_insert_guard BEFORE INSERT ON run_environment_bindings
  FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_insert('ownerId');
DROP TRIGGER IF EXISTS account_deletion_insert_guard ON run_action_executions;
CREATE TRIGGER account_deletion_insert_guard BEFORE INSERT ON run_action_executions
  FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_insert('ownerId');
