-- target: MIKKA_DATABASE_URL
-- Session revocation publishes durable work after commit without introducing a
-- recurring poll or locking execution rows inside the auth transaction.
CREATE TABLE resource_session_revocations (
  "sessionId" text PRIMARY KEY,
  "actorId" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "deliveredAt" timestamptz
);
CREATE INDEX resource_session_revocations_due_idx ON resource_session_revocations("createdAt") WHERE "deliveredAt" IS NULL;
CREATE INDEX resource_access_grants_expiry_idx ON resource_access_grants("expiresAt") WHERE "expiresAt" IS NOT NULL;
CREATE INDEX thread_execution_grants_expiry_idx ON thread_execution_grants("expiresAt") WHERE "revokedAt" IS NULL;
CREATE INDEX thread_execution_authorizations_expiry_idx ON thread_execution_authorizations("expiresAt") WHERE "releasedAt" IS NULL;

CREATE FUNCTION mikka_session_resource_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW."expiresAt">=OLD."expiresAt" THEN RETURN NEW; END IF;
  IF EXISTS(SELECT 1 FROM thread_execution_authorizations WHERE "sessionId"=OLD.id AND "releasedAt" IS NULL) THEN
    INSERT INTO resource_session_revocations("sessionId","actorId") VALUES(OLD.id,OLD."userId")
      ON CONFLICT("sessionId") DO UPDATE SET "createdAt"=clock_timestamp(),"deliveredAt"=NULL;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;
CREATE TRIGGER resource_session_revocation AFTER DELETE OR UPDATE OF "expiresAt" ON "session"
  FOR EACH ROW EXECUTE FUNCTION mikka_session_resource_revocation();
