-- target: DATABASE_URL
CREATE TABLE IF NOT EXISTS workspace_environment_setup_versions (
  "workspaceId" uuid NOT NULL,
  "environmentId" uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  recipe jsonb CHECK (recipe IS NULL OR (jsonb_typeof(recipe) = 'object' AND NOT recipe ? 'approved')),
  "recordedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("environmentId", revision),
  FOREIGN KEY ("environmentId", "workspaceId") REFERENCES workspace_environments(id, "workspaceId") ON DELETE CASCADE
);

-- Old events contain revision numbers only. Preserve the known current recipe as the baseline.
INSERT INTO workspace_environment_setup_versions ("workspaceId","environmentId",revision,recipe,"recordedAt")
SELECT "workspaceId",id,revision,(configuration->'setup') - 'approved',"updatedAt"
FROM workspace_environments e
WHERE NOT EXISTS (SELECT 1 FROM workspace_environment_setup_versions v WHERE v."environmentId"=e.id)
ON CONFLICT DO NOTHING;
