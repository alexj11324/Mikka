-- target: DATABASE_URL
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
