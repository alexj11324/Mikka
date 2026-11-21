-- Durable confirmation and audit for user-initiated Git writes. A preview is
-- only a token: the device re-derives the current HEAD and exact content
-- fences before writing, and a stale/duplicate operation is refused. The
-- masked pre-operation capture supports one Undo inside the retention window.
CREATE TABLE IF NOT EXISTS coding_workspace_git_operations (
  "operationId" uuid PRIMARY KEY,
  "runId" uuid NOT NULL,
  "repoId" uuid NOT NULL,
  "ownerId" text NOT NULL,
  "workspaceId" uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('revert','restore')),
  state text NOT NULL CHECK (state IN ('previewed','delivering','applied','failed','undone')),
  "requestFingerprint" text NOT NULL CHECK ("requestFingerprint" ~ '^[a-f0-9]{64}$'),
  "previewVersion" text CHECK ("previewVersion" ~ '^[a-f0-9]{64}$'),
  "checkpointId" text CHECK ("checkpointId" IS NULL OR char_length("checkpointId") BETWEEN 1 AND 80),
  revision jsonb CHECK (revision IS NULL OR (jsonb_typeof(revision)='object' AND octet_length(revision::text)<=8192)),
  files jsonb CHECK (files IS NULL OR (jsonb_typeof(files)='array' AND octet_length(files::text)<=524288)),
  expected jsonb CHECK (expected IS NULL OR (jsonb_typeof(expected)='object' AND octet_length(expected::text)<=8192)),
  payload jsonb CHECK (payload IS NULL OR (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=2097152)),
  receipt jsonb CHECK (receipt IS NULL OR (jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=16384)),
  "undoFiles" jsonb CHECK ("undoFiles" IS NULL OR (jsonb_typeof("undoFiles")='array' AND octet_length("undoFiles"::text)<=1572864)),
  "undoMaskPolicy" text CHECK ("undoMaskPolicy" IS NULL OR "undoMaskPolicy" ~ '^[a-f0-9]{64}$'),
  "undoAvailable" boolean NOT NULL DEFAULT false,
  "undoReason" text CHECK ("undoReason" IS NULL OR "undoReason" IN ('secret','too_large','none')),
  "undoClaimedAt" timestamptz,
  "undoReceipt" jsonb CHECK ("undoReceipt" IS NULL OR (jsonb_typeof("undoReceipt")='object' AND octet_length("undoReceipt"::text)<=16384)),
  "expiresAt" timestamptz NOT NULL,
  "undoExpiresAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CHECK (("undoFiles" IS NULL) = ("undoMaskPolicy" IS NULL)),
  FOREIGN KEY ("runId","repoId","ownerId","workspaceId")
    REFERENCES coding_workspace_bindings ("runId","repoId","ownerId","workspaceId") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS coding_workspace_git_operations_run
  ON coding_workspace_git_operations ("runId","repoId","ownerId","createdAt" DESC);
CREATE INDEX IF NOT EXISTS coding_workspace_git_operations_owner
  ON coding_workspace_git_operations ("ownerId","createdAt" DESC);
CREATE INDEX IF NOT EXISTS coding_workspace_git_operations_expiry
  ON coding_workspace_git_operations ("expiresAt");

DROP TRIGGER IF EXISTS account_deletion_insert_guard ON coding_workspace_git_operations;
CREATE TRIGGER account_deletion_insert_guard BEFORE INSERT ON coding_workspace_git_operations
  FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_insert('ownerId');
