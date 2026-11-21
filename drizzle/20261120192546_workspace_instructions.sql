-- target: MIKKA_DATABASE_URL

-- Workspace-wide instructions are distinct from personal and thread-title instructions.
-- Rollback: revert application code and retain this additive table and its data.
CREATE TABLE IF NOT EXISTS workspace_instructions (
  "workspaceId" uuid PRIMARY KEY,
  instructions text NOT NULL DEFAULT '',
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_instructions_length CHECK (char_length(instructions) <= 2000)
);

-- Preserve an earlier registry write if this migration follows a rolling deployment.
INSERT INTO workspace_instructions ("workspaceId", instructions, "updatedAt")
SELECT "workspaceId", coalesce("textValue", ''), "updatedAt"
FROM workspace_setting_values WHERE key = 'workspaceInstructions'
ON CONFLICT ("workspaceId") DO NOTHING;
