-- target: MIKKA_DATABASE_URL
-- Intentionally no value, username, token, URL query or provider response columns.
CREATE TABLE credential_requests (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  workspace_id uuid NOT NULL,
  task_id uuid NOT NULL,
  run_id uuid NOT NULL,
  execution_session text NOT NULL,
  auth_session_id text NOT NULL,
  service_id varchar(64) NOT NULL,
  service_policy_hash text NOT NULL,
  target_origin text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('api_header', 'browser_login')),
  state text NOT NULL CHECK (state IN ('pending', 'submitting', 'ready', 'using', 'active_session', 'consumed', 'cancelled', 'expired', 'failed', 'disconnected')),
  nonce_hash text NOT NULL,
  vault_ref uuid NOT NULL UNIQUE,
  retention text NOT NULL CHECK (retention IN ('once', 'session')),
  expires_at timestamptz NOT NULL,
  use_expires_at timestamptz,
  cleanup_pending boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credential_requests_cleanup ON credential_requests (updated_at) WHERE cleanup_pending;
CREATE INDEX credential_requests_run ON credential_requests (run_id, owner_id);
CREATE UNIQUE INDEX credential_requests_active_binding ON credential_requests
  (owner_id, workspace_id, run_id, execution_session, service_id)
  WHERE state IN ('pending', 'submitting', 'ready', 'using', 'active_session');

-- Lifecycle revocation is independent of application callbacks and BYOS token changes.
-- No network IO in a DB trigger; cleanup is retried by the independent sweep.
CREATE FUNCTION credential_revoke_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    UPDATE credential_requests SET state='disconnected', cleanup_pending=true, version=version+1, updated_at=now()
      WHERE run_id=OLD.id AND state IN ('pending','submitting','ready','using','active_session');
    RETURN OLD;
  END IF;
  IF NEW.status NOT IN ('running','waiting_input') OR NEW."stopRequestedAt" IS NOT NULL
     OR NEW."sessionId" IS DISTINCT FROM OLD."sessionId" OR NEW."userId" IS DISTINCT FROM OLD."userId"
     OR NEW."issueId" IS DISTINCT FROM OLD."issueId" OR NEW."deviceId" IS DISTINCT FROM OLD."deviceId" THEN
    UPDATE credential_requests SET state='disconnected', cleanup_pending=true, version=version+1, updated_at=now()
      WHERE run_id=OLD.id AND state IN ('pending','submitting','ready','using','active_session');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER credential_run_lifecycle BEFORE UPDATE OR DELETE ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION credential_revoke_run();

CREATE FUNCTION credential_revoke_auth_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    UPDATE credential_requests SET state='disconnected', cleanup_pending=true, version=version+1, updated_at=now()
      WHERE auth_session_id=OLD.id AND state IN ('pending','submitting','ready','using','active_session');
    RETURN OLD;
  END IF;
  IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."expiresAt"<=now() THEN
    UPDATE credential_requests SET state='disconnected', cleanup_pending=true, version=version+1, updated_at=now()
      WHERE auth_session_id=OLD.id AND state IN ('pending','submitting','ready','using','active_session');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER credential_auth_lifecycle BEFORE UPDATE OR DELETE ON "session"
  FOR EACH ROW EXECUTE FUNCTION credential_revoke_auth_session();

CREATE FUNCTION credential_revoke_device() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    UPDATE credential_requests SET state='disconnected', cleanup_pending=true, version=version+1, updated_at=now()
      WHERE run_id IN (SELECT id FROM agent_runs WHERE "deviceId"=OLD.id) AND state IN ('pending','submitting','ready','using','active_session');
    RETURN OLD;
  END IF;
  IF NOT NEW.enabled OR NEW."ownerId" IS DISTINCT FROM OLD."ownerId" THEN
    UPDATE credential_requests SET state='disconnected', cleanup_pending=true, version=version+1, updated_at=now()
      WHERE run_id IN (SELECT id FROM agent_runs WHERE "deviceId"=OLD.id) AND state IN ('pending','submitting','ready','using','active_session');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER credential_device_lifecycle BEFORE UPDATE OR DELETE ON devices
  FOR EACH ROW EXECUTE FUNCTION credential_revoke_device();
