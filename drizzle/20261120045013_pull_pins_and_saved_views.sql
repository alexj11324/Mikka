-- target: MIKKA_DATABASE_URL

-- A person's own PR pins and saved list views, per workspace, so both follow
-- them across devices (they lived in sessionStorage before). Workspaces live in
-- the workspace database, so "workspaceId" carries no foreign key, as on the
-- other per-person rows here. Safe to run again.
SET LOCAL lock_timeout = '5s';

-- `pullKey` is the PR's lowercased GitHub URL (lib/issue-metadata.ts githubPullRequestKey).
CREATE TABLE IF NOT EXISTS pull_pins (
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "workspaceId" uuid NOT NULL,
  "pullKey" text NOT NULL CHECK ("pullKey" ~ '^https://github\.com/[a-z0-9_.-]+/[a-z0-9_.-]+/pull/[1-9][0-9]{0,9}$'),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", "workspaceId", "pullKey")
);

-- One saved combination of filters for a list. `scope` names the list; the
-- filters are that list's own shape, validated by its reader (lib/saved-views.ts).
CREATE TABLE IF NOT EXISTS saved_views (
  id uuid PRIMARY KEY,
  "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "workspaceId" uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('pulls', 'threads', 'tasks')),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  filters jsonb NOT NULL CHECK (jsonb_typeof(filters) = 'object' AND pg_column_size(filters) <= 8192),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("ownerId", "workspaceId", scope, name)
);
