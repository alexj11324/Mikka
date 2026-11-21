-- target: DATABASE_URL

-- Rollback retains verification receipts and invitation scopes. Reverting a
-- DNS-enforcement release requires disabling domain admission first; do not
-- interpret pending domains or scoped invitations as legacy verified grants.
ALTER TABLE mikka_organization_join_domains ADD COLUMN IF NOT EXISTS "verifiedAt" timestamptz;
ALTER TABLE mikka_organization_join_domains ADD COLUMN IF NOT EXISTS "lastCheckedAt" timestamptz;
ALTER TABLE mikka_organization_join_domains ADD COLUMN IF NOT EXISTS "verificationError" text;
ALTER TABLE mikka_organization_invitations ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mikka_org_invitation_role') THEN
    ALTER TABLE mikka_organization_invitations ADD CONSTRAINT mikka_org_invitation_role CHECK (role IN ('admin','member'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mikka_org_domain_verification_error') THEN
    ALTER TABLE mikka_organization_join_domains ADD CONSTRAINT mikka_org_domain_verification_error
      CHECK ("verificationError" IS NULL OR "verificationError" IN ('record_missing','lookup_failed'));
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS mikka_organization_invitation_teams (
  "invitationId" uuid NOT NULL REFERENCES mikka_organization_invitations(id) ON DELETE CASCADE,
  "teamId" uuid NOT NULL,
  "workspaceId" uuid NOT NULL,
  PRIMARY KEY ("invitationId","teamId")
);
CREATE INDEX IF NOT EXISTS mikka_org_invitation_teams_team_idx ON mikka_organization_invitation_teams ("teamId");
