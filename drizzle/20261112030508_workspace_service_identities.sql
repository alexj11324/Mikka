-- target: DATABASE_URL
CREATE TABLE mikka_workspace_service_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspaceId" uuid NOT NULL REFERENCES mikka_workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  "createdBy" text NOT NULL,
  "requestId" uuid NOT NULL,
  "initialName" text NOT NULL,
  UNIQUE ("workspaceId", "createdBy", "requestId")
);
CREATE INDEX mikka_workspace_service_identities_page ON mikka_workspace_service_identities ("workspaceId", id);
