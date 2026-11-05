-- Logical coding profiles; physical agents and existing run history keep their identity.
CREATE TABLE IF NOT EXISTS factory_agent_profiles (
  id uuid PRIMARY KEY,
  "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "workspaceId" uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  skills jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(skills) = 'array'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "archivedAt" timestamptz,
  UNIQUE (id, "ownerId", "workspaceId")
);
CREATE INDEX IF NOT EXISTS factory_agent_profiles_scope_idx ON factory_agent_profiles ("ownerId", "workspaceId", "createdAt", id) WHERE "archivedAt" IS NULL;
CREATE TABLE IF NOT EXISTS factory_agent_profile_versions (
  "profileId" uuid NOT NULL,
  "ownerId" text NOT NULL,
  "workspaceId" uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  skills jsonb NOT NULL CHECK (jsonb_typeof(skills) = 'array'),
  digest text NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
  action text NOT NULL CHECK (action IN ('create', 'update', 'archive')),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("profileId", version),
  FOREIGN KEY ("profileId", "ownerId", "workspaceId") REFERENCES factory_agent_profiles (id, "ownerId", "workspaceId") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS factory_agent_profile_versions_scope_idx ON factory_agent_profile_versions ("ownerId", "workspaceId", "profileId", version DESC);
