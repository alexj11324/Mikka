-- Additive, explicit migration only. No build-time production migration.
CREATE TABLE IF NOT EXISTS bot_subagents (
 id uuid PRIMARY KEY,
 "workspaceId" uuid NOT NULL,
 "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 "botId" uuid NOT NULL,
 task text NOT NULL CHECK (length(task) BETWEEN 1 AND 2000),
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','needs_you','done','failed','stopped')),
 step text NOT NULL DEFAULT '', needs jsonb, "targetId" text,
 epoch integer NOT NULL DEFAULT 1,
 "createdAt" timestamptz NOT NULL DEFAULT now(), "endedAt" timestamptz,
 FOREIGN KEY ("botId","workspaceId","ownerId") REFERENCES bots(id,"workspaceId","ownerId") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS bot_subagents_queue_idx ON bot_subagents("workspaceId","ownerId",status,"createdAt");
CREATE TABLE IF NOT EXISTS subagent_events (
 seq bigserial PRIMARY KEY, "ownerId" text NOT NULL, "workspaceId" uuid NOT NULL, "botId" uuid NOT NULL,
 "subagentId" uuid NOT NULL REFERENCES bot_subagents(id) ON DELETE CASCADE,
 event jsonb NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subagent_events_owner_idx ON subagent_events("ownerId","workspaceId",seq);
CREATE TABLE IF NOT EXISTS workspace_snapshots (
 "workspaceId" uuid NOT NULL,"ownerId" text NOT NULL,"sourceRevision" text NOT NULL,
 "lockDigest" text NOT NULL,"snapshotId" text NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY ("workspaceId","ownerId")
);
CREATE TABLE IF NOT EXISTS thread_machines (
 "runId" uuid PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
 "workspaceId" uuid NOT NULL,"ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 "sandboxId" text UNIQUE,"snapshotId" text NOT NULL,"operationId" uuid NOT NULL,
 state text NOT NULL CHECK (state IN ('starting','running','paused','ended','error')),
 "deviceId" uuid REFERENCES devices(id),"lastActiveAt" timestamptz NOT NULL DEFAULT now(),
 "createdAt" timestamptz NOT NULL DEFAULT now(),"endedAt" timestamptz
);
CREATE TABLE IF NOT EXISTS suggestion_executions (
 "suggestionId" uuid PRIMARY KEY REFERENCES suggestions(id) ON DELETE CASCADE,
 "ownerId" text NOT NULL,"workspaceId" uuid NOT NULL,"botId" uuid NOT NULL,
 instruction text NOT NULL,status text NOT NULL DEFAULT 'starting' CHECK(status IN ('starting','running','done','failed','stopped')),
 "subagentId" uuid REFERENCES bot_subagents(id),"runId" uuid REFERENCES agent_runs(id),
 "createdAt" timestamptz NOT NULL DEFAULT now(),"endedAt" timestamptz
);
ALTER TABLE thread_machines ADD COLUMN IF NOT EXISTS "workerLeaseId" uuid;
ALTER TABLE thread_machines ADD COLUMN IF NOT EXISTS "workerLeaseUntil" timestamptz;
ALTER TABLE thread_machines ADD COLUMN IF NOT EXISTS "repoId" uuid REFERENCES device_repos(id);
ALTER TABLE thread_machines ADD COLUMN IF NOT EXISTS "botId" uuid REFERENCES bots(id);
ALTER TABLE thread_machines ADD COLUMN IF NOT EXISTS "targetId" text;
ALTER TABLE thread_machines ADD COLUMN IF NOT EXISTS epoch integer NOT NULL DEFAULT 1;
