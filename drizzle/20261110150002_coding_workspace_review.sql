-- Retained review artifacts are independent of the lifetime of a device or
-- its device_repos row. Workspace membership lives in the other database;
-- application writes hold its workspace/member lease through this commit.
CREATE TABLE IF NOT EXISTS coding_workspace_bindings (
  "runId" uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  "repoId" uuid NOT NULL,
  "ownerId" text NOT NULL,
  "workspaceId" uuid NOT NULL,
  "repositoryKey" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("runId", "repoId"),
  UNIQUE ("runId","repoId","ownerId","workspaceId"),
  FOREIGN KEY ("runId","ownerId") REFERENCES agent_runs(id,"userId") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS coding_workspace_bindings_workspace ON coding_workspace_bindings ("workspaceId");

-- Boards belong to a task/repository, or to a taskless Run. A reviewer leaving
-- must not delete the board and the other reviewers' work.
CREATE TABLE IF NOT EXISTS coding_workspace_review_boards (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  "workspaceId" uuid NOT NULL,
  "taskId" uuid REFERENCES issues(id) ON DELETE CASCADE,
  "runId" uuid REFERENCES agent_runs(id) ON DELETE CASCADE,
  "repositoryKey" text NOT NULL,
  revision integer NOT NULL DEFAULT 0 CHECK (revision>=0),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CHECK (("taskId" IS NULL) <> ("runId" IS NULL))
);
CREATE INDEX IF NOT EXISTS coding_workspace_review_boards_workspace ON coding_workspace_review_boards ("workspaceId");
CREATE UNIQUE INDEX IF NOT EXISTS coding_workspace_review_boards_task ON coding_workspace_review_boards ("workspaceId","taskId","repositoryKey") WHERE "taskId" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS coding_workspace_review_boards_run ON coding_workspace_review_boards ("workspaceId","runId","repositoryKey") WHERE "runId" IS NOT NULL;

CREATE TABLE IF NOT EXISTS coding_workspace_snapshots (
  id uuid PRIMARY KEY,
  "runId" uuid NOT NULL,
  "repoId" uuid NOT NULL,
  "ownerId" text NOT NULL,
  "workspaceId" uuid NOT NULL,
  "boardId" text NOT NULL REFERENCES coding_workspace_review_boards(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('working','checkpoint','commit','pull_request')),
  version text NOT NULL CHECK (version ~ '^[a-f0-9]{64}$'),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=16384),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY ("runId","repoId","ownerId","workspaceId") REFERENCES coding_workspace_bindings ("runId","repoId","ownerId","workspaceId") ON DELETE CASCADE,
  UNIQUE (id,"boardId"),
  UNIQUE ("runId","repoId",source,version)
);
CREATE INDEX IF NOT EXISTS coding_workspace_snapshots_run ON coding_workspace_snapshots ("runId","repoId","createdAt" DESC);
CREATE INDEX IF NOT EXISTS coding_workspace_snapshots_workspace ON coding_workspace_snapshots ("workspaceId");

-- Latest checkpoint state is separate from immutable content. An unchanged
-- final capture can reuse a snapshot; a new unavailable capture supersedes it.
CREATE TABLE IF NOT EXISTS coding_workspace_checkpoint_reviews (
  "runId" uuid PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  "repoId" uuid NOT NULL,
  "ownerId" text NOT NULL,
  "workspaceId" uuid NOT NULL,
  "snapshotId" uuid REFERENCES coding_workspace_snapshots(id) ON DELETE SET NULL,
  "baseSha" text NOT NULL,
  "headSha" text,
  "treeSha" text,
  reason text CHECK (reason IN ('missing_evidence','too_large','unsupported','version_changed')),
  "capturedAt" timestamptz NOT NULL,
  FOREIGN KEY ("runId","repoId","ownerId","workspaceId") REFERENCES coding_workspace_bindings ("runId","repoId","ownerId","workspaceId") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS coding_workspace_checkpoint_reviews_workspace ON coding_workspace_checkpoint_reviews ("workspaceId");

CREATE TABLE IF NOT EXISTS coding_workspace_snapshot_files (
  "snapshotId" uuid NOT NULL REFERENCES coding_workspace_snapshots(id) ON DELETE CASCADE,
  path text NOT NULL,
  position integer NOT NULL CHECK (position>=0 AND position<20000),
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<=8192),
  patch jsonb CHECK (jsonb_typeof(patch)='object' AND octet_length(patch::text)<=1048576),
  "maskPolicy" text CHECK ("maskPolicy" ~ '^[a-f0-9]{64}$'),
  CHECK ((patch IS NULL) = ("maskPolicy" IS NULL)),
  PRIMARY KEY ("snapshotId",path),
  UNIQUE ("snapshotId",position)
);

CREATE TABLE IF NOT EXISTS coding_workspace_review_comments (
  id uuid PRIMARY KEY,
  "boardId" text NOT NULL REFERENCES coding_workspace_review_boards(id) ON DELETE CASCADE,
  "threadId" uuid NOT NULL,
  "snapshotId" uuid NOT NULL,
  "userId" text NOT NULL,
  anchor jsonb NOT NULL CHECK (jsonb_typeof(anchor)='object' AND octet_length(anchor::text)<=8192),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  draft boolean NOT NULL DEFAULT true,
  resolved boolean NOT NULL DEFAULT false,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,"boardId","snapshotId"),
  FOREIGN KEY ("snapshotId","boardId") REFERENCES coding_workspace_snapshots(id,"boardId") ON DELETE CASCADE,
  FOREIGN KEY ("threadId","boardId","snapshotId") REFERENCES coding_workspace_review_comments(id,"boardId","snapshotId") ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS coding_workspace_review_comments_board ON coding_workspace_review_comments ("boardId","createdAt",id);
CREATE INDEX IF NOT EXISTS coding_workspace_review_comments_thread ON coding_workspace_review_comments ("threadId");
CREATE INDEX IF NOT EXISTS coding_workspace_review_comments_user ON coding_workspace_review_comments ("userId");

CREATE TABLE IF NOT EXISTS coding_workspace_reviewed_files (
  "boardId" text NOT NULL REFERENCES coding_workspace_review_boards(id) ON DELETE CASCADE,
  "userId" text NOT NULL,
  path text NOT NULL,
  "fileVersion" text NOT NULL CHECK ("fileVersion" ~ '^[a-f0-9]{64}$'),
  "reviewedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("boardId","userId",path)
);
CREATE INDEX IF NOT EXISTS coding_workspace_reviewed_files_user ON coding_workspace_reviewed_files ("userId");

CREATE TABLE IF NOT EXISTS coding_workspace_review_receipts (
  "boardId" text NOT NULL REFERENCES coding_workspace_review_boards(id) ON DELETE CASCADE,
  "userId" text NOT NULL,
  "requestId" uuid NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  action text NOT NULL,
  response jsonb NOT NULL CHECK (jsonb_typeof(response)='object' AND octet_length(response::text)<=16384),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("boardId","userId","requestId")
);
CREATE INDEX IF NOT EXISTS coding_workspace_review_receipts_user ON coding_workspace_review_receipts ("userId");

CREATE TABLE IF NOT EXISTS coding_workspace_review_batches (
  id uuid PRIMARY KEY,
  "boardId" text NOT NULL REFERENCES coding_workspace_review_boards(id) ON DELETE CASCADE,
  "snapshotId" uuid NOT NULL,
  "userId" text NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  destination text NOT NULL CHECK (destination IN ('agent','github')),
  state text NOT NULL CHECK (state IN ('prepared','delivering','accepted','rejected','uncertain')),
  input jsonb NOT NULL CHECK (jsonb_typeof(input)='object' AND octet_length(input::text)<=32768),
  receipt jsonb CHECK (jsonb_typeof(receipt)='object' AND octet_length(receipt::text)<=16384),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY ("snapshotId","boardId") REFERENCES coding_workspace_snapshots(id,"boardId") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS coding_workspace_review_batches_board ON coding_workspace_review_batches ("boardId","createdAt",id);
CREATE INDEX IF NOT EXISTS coding_workspace_review_batches_user ON coding_workspace_review_batches ("userId");

CREATE OR REPLACE FUNCTION mikka_workspace_review_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'workspace_snapshot_immutable' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS coding_workspace_binding_immutable ON coding_workspace_bindings;
CREATE TRIGGER coding_workspace_binding_immutable BEFORE UPDATE ON coding_workspace_bindings FOR EACH ROW EXECUTE FUNCTION mikka_workspace_review_immutable();
DROP TRIGGER IF EXISTS coding_workspace_snapshot_immutable ON coding_workspace_snapshots;
CREATE TRIGGER coding_workspace_snapshot_immutable BEFORE UPDATE ON coding_workspace_snapshots FOR EACH ROW EXECUTE FUNCTION mikka_workspace_review_immutable();

CREATE OR REPLACE FUNCTION mikka_workspace_review_file_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."snapshotId",NEW.path,NEW.position,NEW.metadata) IS DISTINCT FROM (OLD."snapshotId",OLD.path,OLD.position,OLD.metadata)
    OR (OLD.patch IS NOT NULL AND (NEW.patch,NEW."maskPolicy") IS DISTINCT FROM (OLD.patch,OLD."maskPolicy"))
    THEN RAISE EXCEPTION 'workspace_snapshot_immutable' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS coding_workspace_snapshot_file_immutable ON coding_workspace_snapshot_files;
CREATE TRIGGER coding_workspace_snapshot_file_immutable BEFORE UPDATE ON coding_workspace_snapshot_files FOR EACH ROW EXECUTE FUNCTION mikka_workspace_review_file_immutable();

DROP TRIGGER IF EXISTS account_deletion_insert_guard ON coding_workspace_bindings;
CREATE TRIGGER account_deletion_insert_guard BEFORE INSERT ON coding_workspace_bindings
  FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_insert('ownerId');
DROP TRIGGER IF EXISTS account_deletion_insert_guard ON coding_workspace_snapshots;
CREATE TRIGGER account_deletion_insert_guard BEFORE INSERT ON coding_workspace_snapshots
  FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_insert('ownerId');
DROP TRIGGER IF EXISTS account_deletion_insert_guard ON coding_workspace_checkpoint_reviews;
CREATE TRIGGER account_deletion_insert_guard BEFORE INSERT ON coding_workspace_checkpoint_reviews
  FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_insert('ownerId');
DROP TRIGGER IF EXISTS account_deletion_insert_guard ON coding_workspace_review_comments;
CREATE TRIGGER account_deletion_insert_guard BEFORE INSERT ON coding_workspace_review_comments
  FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_insert('userId');
DROP TRIGGER IF EXISTS account_deletion_insert_guard ON coding_workspace_reviewed_files;
CREATE TRIGGER account_deletion_insert_guard BEFORE INSERT ON coding_workspace_reviewed_files
  FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_insert('userId');
DROP TRIGGER IF EXISTS account_deletion_insert_guard ON coding_workspace_review_receipts;
CREATE TRIGGER account_deletion_insert_guard BEFORE INSERT ON coding_workspace_review_receipts
  FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_insert('userId');
DROP TRIGGER IF EXISTS account_deletion_insert_guard ON coding_workspace_review_batches;
CREATE TRIGGER account_deletion_insert_guard BEFORE INSERT ON coding_workspace_review_batches
  FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_insert('userId');
