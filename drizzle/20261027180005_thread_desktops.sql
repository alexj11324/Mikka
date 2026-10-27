ALTER TABLE thread_machines ADD COLUMN IF NOT EXISTS "runtimeReady" boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS computer_run_binding_desktop_scope_idx ON computer_run_bindings("runId", "workspaceId", "ownerId", "botId");
CREATE TABLE IF NOT EXISTS thread_desktops (
  "runId" uuid PRIMARY KEY,
  "workspaceId" uuid NOT NULL,
  "ownerId" text NOT NULL,
  "botId" uuid NOT NULL,
  control text NOT NULL DEFAULT 'agent' CHECK (control IN ('agent','user','idle')),
  "controlledBy" text,
  "controlUntil" timestamptz,
  epoch integer NOT NULL DEFAULT 0,
  "lastAction" jsonb,
  FOREIGN KEY ("runId", "workspaceId", "ownerId", "botId") REFERENCES computer_run_bindings("runId", "workspaceId", "ownerId", "botId") ON DELETE RESTRICT,
  FOREIGN KEY ("botId", "workspaceId", "ownerId") REFERENCES bots(id, "workspaceId", "ownerId") ON DELETE RESTRICT
);
