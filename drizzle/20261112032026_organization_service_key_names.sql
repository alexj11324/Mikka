-- target: DATABASE_URL

-- A rotation inserts a new binding, so a key's public ID and name live for that issuance only.
ALTER TABLE mikka_service_key_organization_bindings
  ADD COLUMN "keyId" uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN name text CHECK (char_length(name) BETWEEN 1 AND 100),
  ADD CONSTRAINT mikka_service_key_public_id UNIQUE ("keyId");
