-- target: MIKKA_DATABASE_URL
-- Live authority lives beside Auth. Deliberately no session/user FK: an
-- account/session DELETE must retain undelivered gateway revocations.
CREATE TABLE enterprise_live_capabilities (
  channel text PRIMARY KEY CHECK (channel ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK (kind IN ('scope','session')),
  "workspaceId" uuid NOT NULL,
  "userId" text NOT NULL,
  "organizationId" uuid,
  "sessionId" text,
  "expiresAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "revokedAt" timestamptz,
  "lastAttemptAt" timestamptz,
  "deliveredAt" timestamptz,
  CONSTRAINT enterprise_live_capability_shape CHECK (
    (kind='scope' AND "sessionId" IS NULL AND "expiresAt" IS NULL AND "revokedAt" IS NOT NULL)
    OR (kind='session' AND "sessionId" IS NOT NULL AND "expiresAt" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX enterprise_live_session_workspace_active
  ON enterprise_live_capabilities ("sessionId","workspaceId")
  WHERE kind='session' AND "revokedAt" IS NULL;
CREATE INDEX enterprise_live_scope_active
  ON enterprise_live_capabilities ("workspaceId","userId","organizationId")
  WHERE kind='session' AND "revokedAt" IS NULL;
CREATE INDEX enterprise_live_pending
  ON enterprise_live_capabilities ("lastAttemptAt","createdAt")
  WHERE "revokedAt" IS NOT NULL AND "deliveredAt" IS NULL;

-- Reuse the main gateway's existing transactionally delivered notification.
-- The Worker receives the same opaque channel control through its push API.
CREATE FUNCTION enterprise_notify_live_capability_revoked() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."revokedAt" IS NOT NULL AND (TG_OP='INSERT' OR OLD."revokedAt" IS NULL) THEN
    PERFORM pg_notify('mikka_builtin_gateway_v1', json_build_object(
      'node',gen_random_uuid()::text,
      'message',json_build_object('type','live_revoked','key',NEW.channel)
    )::text);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER enterprise_live_capability_revoked
AFTER INSERT OR UPDATE OF "revokedAt" ON enterprise_live_capabilities
FOR EACH ROW EXECUTE FUNCTION enterprise_notify_live_capability_revoked();

-- Registration takes this shared advisory lock and then performs an ordinary
-- fresh session read. It never takes a session row/FK lock after the advisory:
-- DELETE already owns the session row before entering this trigger.
CREATE FUNCTION enterprise_revoke_session_live_capabilities() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('enterprise-live-session:'||OLD.id,0));
  UPDATE enterprise_live_capabilities SET "revokedAt"=now()
    WHERE kind='session' AND "sessionId"=OLD.id AND "revokedAt" IS NULL;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER enterprise_live_session_deleted
BEFORE DELETE ON session
FOR EACH ROW EXECUTE FUNCTION enterprise_revoke_session_live_capabilities();
CREATE TRIGGER enterprise_live_session_authority_changed
BEFORE UPDATE OF "userId","expiresAt","enterpriseOrganizationId","enterpriseProviderId","enterpriseDirectoryUserId","enterpriseIdentityId" ON session
FOR EACH ROW WHEN (
  OLD."userId" IS DISTINCT FROM NEW."userId"
  OR NEW."expiresAt" < OLD."expiresAt"
  OR (OLD."enterpriseOrganizationId",OLD."enterpriseProviderId",OLD."enterpriseDirectoryUserId",OLD."enterpriseIdentityId")
    IS DISTINCT FROM (NEW."enterpriseOrganizationId",NEW."enterpriseProviderId",NEW."enterpriseDirectoryUserId",NEW."enterpriseIdentityId")
)
EXECUTE FUNCTION enterprise_revoke_session_live_capabilities();
