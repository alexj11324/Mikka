-- target: MIKKA_DATABASE_URL

CREATE TABLE IF NOT EXISTS pull_request_defaults (
  "workspaceId" uuid NOT NULL,
  "userId" text REFERENCES "user"(id) ON DELETE CASCADE,
  "titlePrefix" text,
  "branchPrefix" text,
  "autoMerge" boolean,
  draft boolean,
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pull_request_defaults_scope UNIQUE NULLS NOT DISTINCT ("workspaceId", "userId"),
  CONSTRAINT pull_request_defaults_title CHECK ("titlePrefix" IS NULL OR length("titlePrefix") <= 80),
  CONSTRAINT pull_request_defaults_branch CHECK ("branchPrefix" IS NULL OR
    (length("branchPrefix") <= 80 AND "branchPrefix" ~ '^([A-Za-z0-9][A-Za-z0-9_-]*(/[A-Za-z0-9][A-Za-z0-9_-]*)*)?$'))
);

CREATE TABLE IF NOT EXISTS workspace_code_review_configuration (
  "workspaceId" uuid PRIMARY KEY,
  model text,
  severity text,
  "ignoredPaths" text[],
  output text,
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT code_review_model_bound CHECK (model IS NULL OR length(model) <= 200),
  CONSTRAINT code_review_severity CHECK (severity IS NULL OR severity IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT code_review_paths_bound CHECK ("ignoredPaths" IS NULL OR cardinality("ignoredPaths") <= 100),
  CONSTRAINT code_review_output CHECK (output IS NULL OR output IN ('comments', 'summary'))
);

CREATE TABLE IF NOT EXISTS workspace_code_review_repositories (
  "workspaceId" uuid NOT NULL,
  repository text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "scheduleId" uuid UNIQUE REFERENCES user_schedules(id) ON DELETE SET NULL,
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("workspaceId", repository)
);

ALTER TABLE run_publications ADD COLUMN IF NOT EXISTS "titlePrefix" text NOT NULL DEFAULT '';
ALTER TABLE run_publications ADD COLUMN IF NOT EXISTS "autoMerge" boolean NOT NULL DEFAULT false;
ALTER TABLE run_publications ADD COLUMN IF NOT EXISTS "defaultDraft" boolean NOT NULL DEFAULT false;
ALTER TABLE run_publications ADD COLUMN IF NOT EXISTS "autoMergeRequestedAt" timestamptz;
