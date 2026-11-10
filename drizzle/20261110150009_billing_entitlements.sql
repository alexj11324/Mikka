-- target: DATABASE_URL
-- Preserve manual cloud grants and self-hosted licenses; Stripe projects into separate fields.
ALTER TABLE mikka_workspace_entitlements
  ADD COLUMN "billingPlan" text NOT NULL DEFAULT 'free' CHECK ("billingPlan" IN ('free','pro','enterprise')),
  ADD COLUMN "billingExpiresAt" timestamptz,
  ADD COLUMN "billingRevision" bigint NOT NULL DEFAULT 0 CHECK ("billingRevision">=0),
  ADD COLUMN "billingSubscriptionId" text;
ALTER TABLE mikka_organization_entitlements
  ADD COLUMN "billingPlan" text NOT NULL DEFAULT 'free' CHECK ("billingPlan" IN ('free','pro','enterprise')),
  ADD COLUMN "billingExpiresAt" timestamptz,
  ADD COLUMN "billingRevision" bigint NOT NULL DEFAULT 0 CHECK ("billingRevision">=0),
  ADD COLUMN "billingSubscriptionId" text,
  ADD COLUMN "billingWorkspaceId" uuid;
CREATE TABLE mikka_organization_billing_accounts (
  "organizationId" uuid PRIMARY KEY REFERENCES mikka_organizations(id) ON DELETE CASCADE,
  "workspaceId" uuid NOT NULL UNIQUE REFERENCES mikka_workspaces(id),
  "createdBy" text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
-- Account designation requires an attached Shared Workspace, even for direct SQL writers.
CREATE FUNCTION mikka_guard_organization_billing_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM mikka_organization_workspaces l JOIN mikka_workspaces w ON w.id=l."workspaceId"
    WHERE l."workspaceId"=NEW."workspaceId" AND l."organizationId"=NEW."organizationId" AND w.kind='team') THEN
    RAISE EXCEPTION 'organization billing account must be an attached shared workspace' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER mikka_organization_billing_account_guard BEFORE INSERT OR UPDATE ON mikka_organization_billing_accounts
FOR EACH ROW EXECUTE FUNCTION mikka_guard_organization_billing_account();
CREATE FUNCTION mikka_guard_organization_billing_detach() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM mikka_organization_billing_accounts a WHERE a."workspaceId"=OLD."workspaceId") THEN
    RAISE EXCEPTION 'designate another billing account before detaching this workspace' USING ERRCODE='23514';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER mikka_organization_billing_detach_guard BEFORE DELETE OR UPDATE ON mikka_organization_workspaces
FOR EACH ROW EXECUTE FUNCTION mikka_guard_organization_billing_detach();
