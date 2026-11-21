-- Personal Skills explicitly shared to a team workspace for Factory Profiles.
-- Only the owner can share; membership and the organization's sharing policy
-- are rechecked on every use. A Profile keeps its pinned body, but a revoked
-- share stops future runs.
-- target: MIKKA_DATABASE_URL
CREATE TABLE IF NOT EXISTS personal_skill_workspace_shares (
  id uuid PRIMARY KEY,
  skill_id uuid NOT NULL REFERENCES personal_skills(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(skill_id,workspace_id)
);
CREATE INDEX IF NOT EXISTS personal_skill_workspace_shares_workspace
  ON personal_skill_workspace_shares(workspace_id,skill_id);
