-- target: DATABASE_URL
CREATE TABLE mikka_organizations (
  id uuid PRIMARY KEY, name varchar(120) NOT NULL, "createdBy" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(), "archivedAt" timestamptz
);
CREATE TABLE mikka_organization_members (
  "organizationId" uuid NOT NULL REFERENCES mikka_organizations(id) ON DELETE CASCADE,
  "userId" text NOT NULL, role text NOT NULL CHECK (role IN ('owner','admin','member')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  name text NOT NULL, email text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("organizationId", "userId")
);
CREATE INDEX mikka_org_members_user_idx ON mikka_organization_members ("userId");
CREATE TABLE mikka_organization_workspaces (
  "workspaceId" uuid PRIMARY KEY REFERENCES mikka_workspaces(id) ON DELETE CASCADE,
  "organizationId" uuid NOT NULL REFERENCES mikka_organizations(id) ON DELETE CASCADE,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mikka_org_workspaces_org_idx ON mikka_organization_workspaces ("organizationId");
CREATE TABLE mikka_organization_entitlements (
  "organizationId" uuid PRIMARY KEY REFERENCES mikka_organizations(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','enterprise')),
  source text NOT NULL DEFAULT 'cloud' CHECK (source IN ('cloud','license')),
  "seatLimit" integer CHECK ("seatLimit" IS NULL OR "seatLimit" > 0), "expiresAt" timestamptz,
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mikka_organization_audit_events (
  id uuid PRIMARY KEY, "organizationId" uuid NOT NULL REFERENCES mikka_organizations(id) ON DELETE CASCADE,
  "actorId" text NOT NULL, action text NOT NULL, "targetId" text,
  result text NOT NULL DEFAULT 'success' CHECK (result IN ('success','denied','failure')), "correlationId" uuid NOT NULL DEFAULT gen_random_uuid(),
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 4096),
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mikka_org_audit_org_created_idx ON mikka_organization_audit_events ("organizationId", "createdAt");
CREATE TABLE mikka_organization_audit_exports (
  id uuid PRIMARY KEY, "organizationId" uuid NOT NULL REFERENCES mikka_organizations(id),
  "createdBy" text NOT NULL, manifest jsonb NOT NULL, records jsonb NOT NULL,
  "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mikka_org_audit_exports_org_expiry_idx ON mikka_organization_audit_exports ("organizationId", "expiresAt");
CREATE TABLE mikka_governance_member_outbox (
  id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL, "userId" text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('suspend','restore')),
  "createdAt" timestamptz NOT NULL DEFAULT now(), "deliveredAt" timestamptz
);
CREATE INDEX mikka_governance_member_outbox_pending_idx ON mikka_governance_member_outbox ("deliveredAt", "createdAt");
CREATE TABLE mikka_organization_resource_policies (
  "organizationId" uuid PRIMARY KEY REFERENCES mikka_organizations(id) ON DELETE CASCADE,
  "modelCredentialSharing" text NOT NULL DEFAULT 'allow' CHECK ("modelCredentialSharing" IN ('allow','approval_required','deny')),
  "mcpSharing" text NOT NULL DEFAULT 'allow' CHECK ("mcpSharing" IN ('allow','approval_required','deny')),
  "allowedModelProviders" jsonb CHECK ("allowedModelProviders" IS NULL OR jsonb_typeof("allowedModelProviders")='array'),
  "auditRetentionDays" integer CHECK ("auditRetentionDays" IS NULL OR "auditRetentionDays" BETWEEN 1 AND 36500),
  "legalHold" boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1,
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mikka_organization_resource_approvals (
  id uuid PRIMARY KEY, "organizationId" uuid NOT NULL REFERENCES mikka_organizations(id) ON DELETE CASCADE,
  "workspaceId" uuid NOT NULL REFERENCES mikka_workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('subscription','api_key','mcp')), "resourceId" text NOT NULL, "ownerId" text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')), "decidedBy" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mikka_resource_approval_resource_unique UNIQUE ("organizationId","workspaceId",kind,"resourceId","ownerId")
);
CREATE TABLE mikka_organization_policy_outbox (
  id uuid PRIMARY KEY, "organizationId" uuid NOT NULL REFERENCES mikka_organizations(id) ON DELETE CASCADE,
  "workspaceIds" jsonb NOT NULL CHECK (jsonb_typeof("workspaceIds")='array'),
  changes jsonb NOT NULL CHECK (jsonb_typeof(changes)='object'),
  "createdAt" timestamptz NOT NULL DEFAULT now(), "deliveredAt" timestamptz
);
