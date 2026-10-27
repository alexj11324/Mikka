-- Internal hosted runners belong to a Bot; they are not Bot identities.
CREATE TABLE IF NOT EXISTS bot_cloud_runtimes (
  "botId" uuid NOT NULL,
  "workspaceId" uuid NOT NULL,
  "ownerId" text NOT NULL,
  harness text NOT NULL CHECK (harness IN ('codex', 'claude_code')),
  "agentId" uuid NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
  "repoId" uuid NOT NULL REFERENCES device_repos(id) ON DELETE CASCADE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("botId", harness),
  FOREIGN KEY ("botId", "workspaceId", "ownerId") REFERENCES bots(id, "workspaceId", "ownerId") ON DELETE CASCADE
);
