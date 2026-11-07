-- target: MIKKA_DATABASE_URL
-- A root and its derived sessions share one verified SAML login lifecycle.
-- No membership, bearer token or raw assertion is stored here.
ALTER TABLE session ADD COLUMN "enterpriseSamlRootSessionId" text REFERENCES session(id) ON DELETE CASCADE;
ALTER TABLE session ADD CONSTRAINT enterprise_saml_root_not_self CHECK ("enterpriseSamlRootSessionId" IS NULL OR "enterpriseSamlRootSessionId"<>id);
CREATE INDEX enterprise_saml_root_session_idx ON session ("enterpriseSamlRootSessionId") WHERE "enterpriseSamlRootSessionId" IS NOT NULL;

CREATE TABLE enterprise_saml_session_lineage (
  "sessionId" text PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
  "rootSessionId" text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "organizationId" uuid NOT NULL,
  "providerId" text NOT NULL REFERENCES enterprise_sso_provider("providerId"),
  "identityId" uuid NOT NULL,
  "nameIdHash" text NOT NULL CHECK ("nameIdHash" ~ '^[a-f0-9]{64}$'),
  "sessionIndexHash" text CHECK ("sessionIndexHash" ~ '^[a-f0-9]{64}$')
);
CREATE INDEX enterprise_saml_session_root_idx ON enterprise_saml_session_lineage ("rootSessionId");
CREATE INDEX enterprise_saml_session_logout_idx ON enterprise_saml_session_lineage ("providerId", "nameIdHash", "sessionIndexHash") WHERE "sessionId"="rootSessionId";

CREATE FUNCTION mikka_validate_saml_session_lineage() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."sessionId"<>NEW."rootSessionId" AND NOT EXISTS (
      SELECT 1 FROM enterprise_saml_session_lineage root WHERE root."sessionId"=NEW."rootSessionId" AND root."rootSessionId"=root."sessionId"
        AND root."userId"=NEW."userId" AND root."organizationId"=NEW."organizationId" AND root."providerId"=NEW."providerId" AND root."identityId"=NEW."identityId"
        AND root."nameIdHash"=NEW."nameIdHash" AND root."sessionIndexHash" IS NOT DISTINCT FROM NEW."sessionIndexHash"))
    OR NOT EXISTS (
      SELECT 1 FROM session root JOIN session child ON child.id=NEW."sessionId"
        JOIN enterprise_sso_provider p ON p."providerId"=NEW."providerId"
        JOIN enterprise_identity i ON i.id=NEW."identityId" AND i."userId"=NEW."userId" AND i."providerId"=NEW."providerId"
      WHERE root.id=NEW."rootSessionId" AND root."userId"=NEW."userId" AND child."userId"=NEW."userId"
        AND root."expiresAt">now() AND child."expiresAt">now() AND root."enterpriseSamlRootSessionId" IS NULL
        AND (child.id=root.id OR child."enterpriseSamlRootSessionId"=root.id)
        AND root."enterpriseOrganizationId"=NEW."organizationId"::text AND child."enterpriseOrganizationId"=NEW."organizationId"::text
        AND root."enterpriseProviderId"=NEW."providerId" AND child."enterpriseProviderId"=NEW."providerId"
        AND root."enterpriseIdentityId"=NEW."identityId"::text AND child."enterpriseIdentityId"=NEW."identityId"::text
        AND p."organizationScopeId"=NEW."organizationId" AND p."samlConfig" IS NOT NULL
    ) THEN
    RAISE EXCEPTION 'enterprise_saml_session_scope_mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER enterprise_saml_lineage_scope BEFORE INSERT OR UPDATE ON enterprise_saml_session_lineage
FOR EACH ROW EXECUTE FUNCTION mikka_validate_saml_session_lineage();

CREATE FUNCTION mikka_cleanup_saml_session_verification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- PostgreSQL's self-FK deletes descendants, including during bulk session
  -- revocation. This trigger never recursively deletes another session.
  DELETE FROM verification WHERE identifier IN ('enterprise-saml-session:' || OLD.id, 'saml-session-by-id:' || OLD.id);
  RETURN OLD;
END;
$$;
CREATE TRIGGER enterprise_saml_session_cleanup BEFORE DELETE ON session
FOR EACH ROW EXECUTE FUNCTION mikka_cleanup_saml_session_verification();
