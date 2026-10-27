-- Additive only. Bots are identities, never worker agents or runs.
CREATE TABLE IF NOT EXISTS bots (
  id uuid PRIMARY KEY,
  "workspaceId" uuid NOT NULL,
  "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, "workspaceId", "ownerId")
);
CREATE TABLE IF NOT EXISTS cloud_machines (
  "workspaceId" uuid PRIMARY KEY,
  "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "sandboxId" text UNIQUE,
  "operationId" uuid NOT NULL,
  "runtimeReady" boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'sleeping' CHECK (state IN ('sleeping','waking','running','error')),
  "lastActiveAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bot_desktops (
  "botId" uuid PRIMARY KEY,
  "workspaceId" uuid NOT NULL REFERENCES cloud_machines("workspaceId") ON DELETE CASCADE,
  "ownerId" text NOT NULL,
  display integer NOT NULL CHECK (display BETWEEN 1 AND 999),
  control text NOT NULL DEFAULT 'idle' CHECK (control IN ('idle','agent','user')),
  "controlledBy" text,
  "controlUntil" timestamptz,
  epoch integer NOT NULL DEFAULT 0,
  "lastAction" jsonb,
  FOREIGN KEY ("botId", "workspaceId", "ownerId") REFERENCES bots(id, "workspaceId", "ownerId") ON DELETE CASCADE,
  UNIQUE ("workspaceId", display)
);
CREATE INDEX IF NOT EXISTS bots_owner_workspace_idx ON bots("ownerId", "workspaceId");
