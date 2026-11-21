-- target: DATABASE_URL
ALTER TABLE mikka_workspace_service_identities
  ADD COLUMN "credentialHash" text CHECK ("credentialHash" ~ '^[0-9a-f]{64}$'),
  ADD COLUMN "credentialExpiresAt" timestamptz,
  ADD CONSTRAINT service_credential_expiry_requires_key CHECK ("credentialHash" IS NOT NULL OR "credentialExpiresAt" IS NULL);
CREATE UNIQUE INDEX mikka_service_credential_hash ON mikka_workspace_service_identities ("credentialHash")
  WHERE "credentialHash" IS NOT NULL;
