-- Workspace-wide computer-use revocation; absent rows retain approval mode.
CREATE TABLE IF NOT EXISTS workspace_computer_policies (
  "workspaceId" uuid PRIMARY KEY,
  permission text NOT NULL DEFAULT 'ask' CHECK (permission IN ('ask', 'deny')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
