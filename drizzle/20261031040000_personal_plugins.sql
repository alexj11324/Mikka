-- Personal connections and skills never inherit workspace sharing.
-- target: MIKKA_DATABASE_URL
CREATE TABLE IF NOT EXISTS personal_mcp_servers (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  url text NOT NULL,
  transport text NOT NULL CHECK (transport IN ('http','sse')),
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1,
  auth_header text,
  ciphertext text,
  iv text,
  key_version integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((auth_header IS NULL AND ciphertext IS NULL AND iv IS NULL AND key_version IS NULL)
      OR (auth_header IS NOT NULL AND ciphertext IS NOT NULL AND iv IS NOT NULL AND key_version IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS personal_mcp_servers_owner ON personal_mcp_servers(user_id,created_at,id);

CREATE TABLE IF NOT EXISTS personal_skills (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name text NOT NULL,
  source text NOT NULL,
  slug text NOT NULL,
  source_kind text NOT NULL DEFAULT 'skills.sh' CHECK (source_kind IN ('skills.sh','built-in','self-improvement')),
  source_revision text NOT NULL,
  source_path text NOT NULL,
  body text NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 20000),
  sha256 text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,source,slug)
);
CREATE INDEX IF NOT EXISTS personal_skills_owner ON personal_skills(user_id,created_at,id);

ALTER TABLE workspace_app_policies DROP CONSTRAINT IF EXISTS workspace_app_policies_app_check;
ALTER TABLE workspace_app_policies ADD CONSTRAINT workspace_app_policies_app_check
  CHECK (app IN ('gmail','googlecalendar','slack','notion','googledrive'));
