-- target: DATABASE_URL
BEGIN;

-- A scope belongs to this specific attachment. Removing and recreating the
-- attachment cannot revive a credential minted before the removal.
ALTER TABLE mikka_organization_workspaces
  ADD CONSTRAINT mikka_service_key_attachment UNIQUE ("workspaceId", "organizationId");
CREATE TABLE mikka_service_key_organization_bindings (
  "identityId" uuid PRIMARY KEY REFERENCES mikka_workspace_service_identities(id) ON DELETE CASCADE,
  "workspaceId" uuid NOT NULL,
  "organizationId" uuid NOT NULL,
  "credentialHash" text NOT NULL CHECK ("credentialHash" ~ '^[0-9a-f]{64}$'),
  FOREIGN KEY ("workspaceId", "organizationId")
    REFERENCES mikka_organization_workspaces("workspaceId", "organizationId") ON DELETE CASCADE
);

-- Also reflect the cutover in the existing Settings status and revision.
-- A late cleanup must leave an already rotated replacement alone.
CREATE FUNCTION mikka_forget_detached_service_key() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE mikka_workspace_service_identities
    SET "credentialHash"=NULL, "credentialExpiresAt"=NULL, revision=revision+1
    WHERE id=OLD."identityId" AND "workspaceId"=OLD."workspaceId"
      AND "credentialHash"=OLD."credentialHash";
  RETURN NULL;
END $$;
CREATE TRIGGER mikka_forget_detached_service_key
  AFTER DELETE ON mikka_service_key_organization_bindings
  FOR EACH ROW EXECUTE FUNCTION mikka_forget_detached_service_key();
COMMIT;
