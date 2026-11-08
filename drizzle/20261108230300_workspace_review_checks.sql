-- A viewer's bounded native check observation is evidence for a review batch,
-- not a merge approval, background poll, or substitute for current GitHub ACL.
CREATE TABLE IF NOT EXISTS coding_workspace_check_observations (
  id uuid PRIMARY KEY,
  "boardId" text NOT NULL REFERENCES coding_workspace_review_boards(id) ON DELETE CASCADE,
  "snapshotId" uuid NOT NULL,
  "workspaceId" uuid NOT NULL,
  "userId" text NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  "maskPolicy" text NOT NULL CHECK ("maskPolicy" ~ '^[a-f0-9]{64}$'),
  "viewerMaskPolicy" text NOT NULL CHECK ("viewerMaskPolicy" ~ '^[a-f0-9]{64}$'),
  observation jsonb NOT NULL CHECK (jsonb_typeof(observation)='object' AND octet_length(observation::text)<=262144),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY ("snapshotId","boardId") REFERENCES coding_workspace_snapshots(id,"boardId") ON DELETE CASCADE,
  UNIQUE ("snapshotId","userId",fingerprint,"maskPolicy","viewerMaskPolicy")
);
CREATE INDEX IF NOT EXISTS coding_workspace_check_observations_board ON coding_workspace_check_observations ("boardId","userId","createdAt" DESC);
CREATE INDEX IF NOT EXISTS coding_workspace_check_observations_workspace ON coding_workspace_check_observations ("workspaceId");
CREATE INDEX IF NOT EXISTS coding_workspace_check_observations_user ON coding_workspace_check_observations ("userId");
DROP TRIGGER IF EXISTS coding_workspace_check_observation_immutable ON coding_workspace_check_observations;
CREATE TRIGGER coding_workspace_check_observation_immutable BEFORE UPDATE ON coding_workspace_check_observations
  FOR EACH ROW EXECUTE FUNCTION mikka_workspace_review_immutable();
DROP TRIGGER IF EXISTS account_deletion_insert_guard ON coding_workspace_check_observations;
CREATE TRIGGER account_deletion_insert_guard BEFORE INSERT ON coding_workspace_check_observations
  FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_insert('userId');

-- Current provider review decisions are observations, separate from the
-- immutable diff and accepted mutation receipts. No background poll writes it.
CREATE TABLE IF NOT EXISTS coding_workspace_pull_states (
  "snapshotId" uuid NOT NULL,
  "boardId" text NOT NULL REFERENCES coding_workspace_review_boards(id) ON DELETE CASCADE,
  "workspaceId" uuid NOT NULL,
  "userId" text NOT NULL,
  observation jsonb NOT NULL CHECK (jsonb_typeof(observation)='object' AND octet_length(observation::text)<=4096),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("snapshotId","userId"),
  FOREIGN KEY ("snapshotId","boardId") REFERENCES coding_workspace_snapshots(id,"boardId") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS coding_workspace_pull_states_workspace ON coding_workspace_pull_states ("workspaceId");
CREATE INDEX IF NOT EXISTS coding_workspace_pull_states_user ON coding_workspace_pull_states ("userId");
DROP TRIGGER IF EXISTS account_deletion_insert_guard ON coding_workspace_pull_states;
CREATE TRIGGER account_deletion_insert_guard BEFORE INSERT ON coding_workspace_pull_states
  FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_insert('userId');
