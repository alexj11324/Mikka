-- Retired provider snapshots remain tracked until no live thread can need
-- them. The active snapshot stays in workspace_snapshots.
CREATE TABLE IF NOT EXISTS workspace_snapshot_versions (
  "snapshotId" text PRIMARY KEY,
  "workspaceId" uuid NOT NULL,
  "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "retiredAt" timestamptz
);
CREATE INDEX IF NOT EXISTS workspace_snapshot_versions_scope_idx ON workspace_snapshot_versions("workspaceId", "ownerId", "retiredAt");
