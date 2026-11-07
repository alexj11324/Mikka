-- Session deletion is the shared revoke authority for browser, desktop, web
-- handoff and user cascades. NOTIFY is delivered only after COMMIT; no token,
-- owner data or session cache content enters this existing gateway bus.
CREATE OR REPLACE FUNCTION mikka_notify_live_session_revoked() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('mikka_builtin_gateway_v1', json_build_object(
    'node', gen_random_uuid()::text,
    'message', json_build_object('type', 'session_revoked', 'sessionId', OLD.id)
  )::text);
  RETURN NULL;
END;
$$;
CREATE TRIGGER live_session_revoked AFTER DELETE ON "session"
FOR EACH ROW EXECUTE FUNCTION mikka_notify_live_session_revoked();
