-- target: DATABASE_URL

BEGIN;
SET LOCAL lock_timeout = '5s';

-- An Org invitation has no Workspace/Project membership or credential effects.
-- Only a hash is durable; the bearer itself is never persisted.
CREATE TABLE mikka_organization_invitations (
  id uuid PRIMARY KEY,
  "organizationId" uuid NOT NULL REFERENCES mikka_organizations(id) ON DELETE CASCADE,
  "createdBy" text NOT NULL,
  email text NOT NULL,
  "tokenHash" text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked')),
  "expiresAt" timestamptz NOT NULL,
  "acceptedBy" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mikka_org_invite_email_valid CHECK (email = lower(btrim(email)) AND length(email) <= 254),
  CONSTRAINT mikka_org_invite_hash_valid CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT mikka_org_invitation_email_unique UNIQUE ("organizationId",email)
);
CREATE INDEX mikka_org_invitation_org_idx ON mikka_organization_invitations ("organizationId","createdAt");

COMMIT;
