-- target: DATABASE_URL
CREATE TABLE mikka_organizations (
  id uuid PRIMARY KEY, name varchar(120) NOT NULL, "createdBy" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
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
CREATE TABLE mikka_workspace_entitlements (
  "workspaceId" uuid PRIMARY KEY REFERENCES mikka_workspaces(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','enterprise')),
  source text NOT NULL DEFAULT 'cloud' CHECK (source IN ('cloud','license')),
  "seatLimit" integer CHECK ("seatLimit" IS NULL OR "seatLimit" > 0), "expiresAt" timestamptz,
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mikka_governance_approval_templates (
  id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES mikka_workspaces(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL, rules jsonb NOT NULL CHECK (jsonb_typeof(rules) = 'object'),
  "createdBy" text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mikka_governance_templates_workspace_idx ON mikka_governance_approval_templates ("workspaceId");
CREATE TABLE mikka_organization_audit_events (
  id uuid PRIMARY KEY, "organizationId" uuid NOT NULL REFERENCES mikka_organizations(id) ON DELETE CASCADE,
  "actorId" text NOT NULL, action text NOT NULL, "targetId" text,
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 4096),
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mikka_org_audit_org_created_idx ON mikka_organization_audit_events ("organizationId", "createdAt");
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

-- Historical corrupt personal peers keep their history but cease to authorize reads.
UPDATE mikka_workspace_members m SET status='suspended'
FROM mikka_workspaces w WHERE w.id=m."workspaceId" AND w.kind='personal' AND m."userId"<>w."userId" AND m.status='active';
CREATE FUNCTION mikka_guard_personal_membership() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tenant mikka_workspaces%ROWTYPE;
BEGIN
  SELECT * INTO tenant FROM mikka_workspaces WHERE id=NEW."workspaceId";
  IF tenant.kind='personal' THEN
    IF NEW."userId"<>tenant."userId" AND (TG_OP='INSERT' OR NEW.status='active') THEN
      RAISE EXCEPTION 'personal workspace admits only its owner' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mikka_personal_membership_guard BEFORE INSERT OR UPDATE ON mikka_workspace_members
FOR EACH ROW EXECUTE FUNCTION mikka_guard_personal_membership();
CREATE FUNCTION mikka_guard_workspace_kind() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind<>OLD.kind OR (OLD.kind='personal' AND NEW."userId"<>OLD."userId") THEN
    RAISE EXCEPTION 'workspace kind and personal ownership are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mikka_workspace_kind_guard BEFORE UPDATE ON mikka_workspaces
FOR EACH ROW EXECUTE FUNCTION mikka_guard_workspace_kind();
