-- Ephemeral, owner-bound RPC receipts. Source text is consumed and deleted by
-- the awaiting request, never added to chat, traces or durable run evidence.
CREATE TABLE IF NOT EXISTS coding_workspace_requests (
  id uuid PRIMARY KEY,
  "ownerId" text NOT NULL,
  "workspaceId" uuid NOT NULL,
  "runId" uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  "repoId" uuid NOT NULL REFERENCES device_repos(id) ON DELETE CASCADE,
  "deviceId" uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  "tokenId" uuid NOT NULL REFERENCES device_tokens(id) ON DELETE CASCADE,
  identity jsonb NOT NULL,
  request jsonb NOT NULL,
  result jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "expiresAt" timestamptz NOT NULL,
  CHECK (jsonb_typeof(identity)='object' AND jsonb_typeof(request)='object'),
  CHECK (octet_length(result::text) <= 2097152)
);
CREATE INDEX IF NOT EXISTS coding_workspace_requests_device_pending
  ON coding_workspace_requests ("deviceId", "expiresAt") WHERE result IS NULL;
CREATE INDEX IF NOT EXISTS coding_workspace_requests_owner ON coding_workspace_requests ("ownerId", "createdAt");
CREATE INDEX IF NOT EXISTS coding_workspace_requests_expiry ON coding_workspace_requests ("expiresAt");
CREATE TABLE IF NOT EXISTS coding_workspace_mentions (
  id uuid PRIMARY KEY,
  "ownerId" text NOT NULL,
  "workspaceId" uuid NOT NULL,
  "runId" uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  "repoId" uuid NOT NULL REFERENCES device_repos(id) ON DELETE CASCADE,
  "bindingId" text NOT NULL,
  files jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "expiresAt" timestamptz NOT NULL,
  CHECK (jsonb_typeof(files)='array' AND jsonb_array_length(files) BETWEEN 1 AND 20)
);
CREATE INDEX IF NOT EXISTS coding_workspace_mentions_owner ON coding_workspace_mentions ("ownerId", "expiresAt");
CREATE INDEX IF NOT EXISTS coding_workspace_mentions_expiry ON coding_workspace_mentions ("expiresAt");

-- Ephemeral rows use the existing account-deletion write fence and dynamic
-- owner cleanup. A closing account cannot recreate context after its sweep.
DROP TRIGGER IF EXISTS account_deletion_insert_guard ON coding_workspace_requests;
CREATE TRIGGER account_deletion_insert_guard BEFORE INSERT ON coding_workspace_requests
  FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_insert('ownerId');
DROP TRIGGER IF EXISTS account_deletion_insert_guard ON coding_workspace_mentions;
CREATE TRIGGER account_deletion_insert_guard BEFORE INSERT ON coding_workspace_mentions
  FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_insert('ownerId');
