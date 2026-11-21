-- target: DATABASE_URL
CREATE TABLE mikka_organization_member_project_defaults (
  "organizationId" uuid NOT NULL,
  "userId" text NOT NULL,
  visibility text NOT NULL CHECK (visibility IN ('private', 'shared')),
  PRIMARY KEY ("organizationId", "userId"),
  FOREIGN KEY ("organizationId", "userId") REFERENCES mikka_organization_members("organizationId", "userId") ON DELETE CASCADE
);
