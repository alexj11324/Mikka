-- target: MIKKA_DATABASE_URL
CREATE TABLE IF NOT EXISTS device_project_checkouts (
  "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "workspaceId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "deviceId" uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  "resourceKind" text NOT NULL DEFAULT 'project' CHECK ("resourceKind" = 'project'),
  root varchar(1024) NOT NULL CHECK (length(root) > 0),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("ownerId", "workspaceId", "projectId", "deviceId"),
  FOREIGN KEY ("resourceKind", "projectId") REFERENCES resource_access_policies(kind,id) ON DELETE CASCADE
);
