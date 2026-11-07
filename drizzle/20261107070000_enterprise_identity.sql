-- Enterprise identity lives beside Better Auth in MIKKA_DATABASE_URL.
-- Organization/workspace UUIDs refer to the existing workspace database; no second membership authority.
CREATE TABLE IF NOT EXISTS enterprise_sso_provider (
  id text PRIMARY KEY,
  "providerId" text NOT NULL UNIQUE,
  "organizationId" text,
  "organizationScopeId" uuid NOT NULL,
  "userId" text REFERENCES "user"(id) ON DELETE SET NULL,
  issuer text NOT NULL,
  domain text NOT NULL UNIQUE,
  "domainVerified" boolean NOT NULL DEFAULT false,
  "oidcConfig" text,
  "samlConfig" text,
  "domainTokenHash" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CHECK (("oidcConfig" IS NULL) <> ("samlConfig" IS NULL))
);
CREATE TABLE IF NOT EXISTS enterprise_org_policy (
  "organizationId" uuid PRIMARY KEY,
  "enforceSso" boolean NOT NULL DEFAULT false,
  "allowMachineCredentials" boolean NOT NULL DEFAULT false,
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS enterprise_scim_connection (
  id uuid PRIMARY KEY,
  "organizationId" uuid NOT NULL,
  "providerId" text NOT NULL REFERENCES enterprise_sso_provider("providerId"),
  "tokenHash" text NOT NULL UNIQUE,
  fence integer NOT NULL DEFAULT 0,
  "revokedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("organizationId", "providerId")
);
CREATE TABLE IF NOT EXISTS enterprise_scim_user (
  id uuid PRIMARY KEY,
  "connectionId" uuid NOT NULL REFERENCES enterprise_scim_connection(id),
  "organizationId" uuid NOT NULL,
  "externalId" text NOT NULL,
  "userName" text NOT NULL,
  "userId" text REFERENCES "user"(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  deleted boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1,
  fence integer NOT NULL DEFAULT 0,
  document jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("connectionId", "externalId"),
  UNIQUE ("connectionId", "userName")
);
CREATE INDEX IF NOT EXISTS enterprise_scim_user_identity_idx ON enterprise_scim_user ("organizationId", "userId");
CREATE TABLE IF NOT EXISTS enterprise_scim_group (
  id uuid PRIMARY KEY,
  "connectionId" uuid NOT NULL REFERENCES enterprise_scim_connection(id),
  "externalId" text,
  "displayName" text NOT NULL,
  document jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("connectionId", "externalId")
);
CREATE TABLE IF NOT EXISTS enterprise_identity (
  id uuid PRIMARY KEY,
  "providerId" text NOT NULL REFERENCES enterprise_sso_provider("providerId"),
  issuer text NOT NULL,
  subject text NOT NULL,
  "directoryUserId" uuid REFERENCES enterprise_scim_user(id),
  "userId" text NOT NULL REFERENCES "user"(id),
  UNIQUE ("providerId", issuer, subject)
);
CREATE TABLE IF NOT EXISTS enterprise_link_ticket (
  id text PRIMARY KEY,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "sessionId" text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  "expiresAt" timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS enterprise_revocation (
  id uuid PRIMARY KEY,
  "organizationId" uuid NOT NULL,
  "directoryUserId" uuid NOT NULL REFERENCES enterprise_scim_user(id),
  "userId" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "deliveredAt" timestamptz,
  UNIQUE ("directoryUserId", "createdAt")
);
CREATE TABLE IF NOT EXISTS enterprise_break_glass (
  "organizationId" uuid NOT NULL,
  "userId" text NOT NULL REFERENCES "user"(id),
  "sessionId" text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  "expiresAt" timestamptz NOT NULL,
  reason text NOT NULL,
  PRIMARY KEY ("organizationId", "sessionId")
);
ALTER TABLE session ADD COLUMN IF NOT EXISTS "enterpriseOrganizationId" text;
ALTER TABLE session ADD COLUMN IF NOT EXISTS "enterpriseProviderId" text;
ALTER TABLE session ADD COLUMN IF NOT EXISTS "enterpriseDirectoryUserId" text;
ALTER TABLE session ADD COLUMN IF NOT EXISTS "enterpriseIdentityId" text;
CREATE INDEX IF NOT EXISTS enterprise_session_directory_idx ON session ("enterpriseDirectoryUserId");
