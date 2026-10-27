-- Additive storage for the separate thread machines and Bot web tasks.
-- Snapshot identifiers are scoped to an owner and workspace; they must never
-- be selected using a workspace id alone.
CREATE TABLE IF NOT EXISTS workspace_snapshots (
  "workspaceId" uuid NOT NULL,
  "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  "snapshotId" text NOT NULL,
  "dependencyFingerprint" text NOT NULL,
  "sourceRevision" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspaceId", "ownerId")
);

CREATE UNIQUE INDEX IF NOT EXISTS computer_run_binding_scope_idx ON computer_run_bindings("runId", "workspaceId", "ownerId");
CREATE TABLE IF NOT EXISTS thread_machines (
  "runId" uuid PRIMARY KEY,
  "workspaceId" uuid NOT NULL,
  "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  "snapshotId" text NOT NULL,
  "operationId" uuid NOT NULL UNIQUE,
  "sandboxId" text UNIQUE,
  "deviceId" uuid UNIQUE REFERENCES devices(id) ON DELETE SET NULL,
  state text NOT NULL DEFAULT 'starting' CHECK (state IN ('starting', 'running', 'paused', 'ended', 'error')),
  desktop boolean NOT NULL DEFAULT false,
  "lastActiveAt" timestamptz NOT NULL DEFAULT now(),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  -- Retain the provider identifier until the machine has been destroyed.
  FOREIGN KEY ("runId", "workspaceId", "ownerId") REFERENCES computer_run_bindings("runId", "workspaceId", "ownerId") ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS thread_machines_owner_workspace_idx ON thread_machines("ownerId", "workspaceId", state);

CREATE TABLE IF NOT EXISTS bot_subagents (
  id uuid PRIMARY KEY,
  "workspaceId" uuid NOT NULL,
  "ownerId" text NOT NULL,
  "botId" uuid NOT NULL,
  task text NOT NULL CHECK (length(trim(task)) > 0),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'needs_you', 'done', 'failed', 'stopped')),
  "browserContextId" text,
  control text NOT NULL DEFAULT 'idle' CHECK (control IN ('idle', 'agent', 'user')),
  "stopRequestedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "endedAt" timestamptz,
  -- Active browser cleanup must happen before deleting the owning Bot.
  FOREIGN KEY ("botId", "workspaceId", "ownerId") REFERENCES bots(id, "workspaceId", "ownerId") ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS bot_subagents_queue_idx ON bot_subagents("workspaceId", "ownerId", state, "createdAt", id);
