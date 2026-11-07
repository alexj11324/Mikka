-- MCP's reply waiter listens on a direct shared session before its fresh read.
-- Trigger payloads contain only row ids; all delivery belongs to this COMMIT.
CREATE OR REPLACE FUNCTION mikka_notify_mcp_reply_message() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND OLD."botId" IS NOT NULL AND OLD.message->>'role' = 'assistant' THEN
    PERFORM pg_notify('mikka_mcp_reply', 'bot:' || OLD."botId"::text);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW."botId" IS NOT NULL AND NEW.message->>'role' = 'assistant' THEN
    PERFORM pg_notify('mikka_mcp_reply', 'bot:' || NEW."botId"::text);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER mcp_reply_message_changed AFTER INSERT OR UPDATE OR DELETE ON coordinator_messages
FOR EACH ROW EXECUTE FUNCTION mikka_notify_mcp_reply_message();

CREATE OR REPLACE FUNCTION mikka_notify_mcp_reply_session() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND
    (NEW."userId", NEW."botId", NEW."leaseHolder", NEW."leaseUntil", NEW."lastError", NEW."lastErrorAt")
    IS NOT DISTINCT FROM
    (OLD."userId", OLD."botId", OLD."leaseHolder", OLD."leaseUntil", OLD."lastError", OLD."lastErrorAt") THEN
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' AND OLD."botId" IS NOT NULL THEN
    PERFORM pg_notify('mikka_mcp_reply', 'bot:' || OLD."botId"::text);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW."botId" IS NOT NULL THEN
    PERFORM pg_notify('mikka_mcp_reply', 'bot:' || NEW."botId"::text);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER mcp_reply_session_changed
AFTER INSERT OR UPDATE OF "userId", "botId", "leaseHolder", "leaseUntil", "lastError", "lastErrorAt" OR DELETE ON coordinator_sessions
FOR EACH ROW EXECUTE FUNCTION mikka_notify_mcp_reply_session();

CREATE OR REPLACE FUNCTION mikka_notify_mcp_reply_bot_scope() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id, NEW."ownerId", NEW."workspaceId")
    IS NOT DISTINCT FROM (OLD.id, OLD."ownerId", OLD."workspaceId") THEN RETURN NULL; END IF;
  PERFORM pg_notify('mikka_mcp_reply', 'bot:' || OLD.id::text);
  IF TG_OP = 'UPDATE' AND NEW.id IS DISTINCT FROM OLD.id THEN
    PERFORM pg_notify('mikka_mcp_reply', 'bot:' || NEW.id::text);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER mcp_reply_bot_scope_changed AFTER UPDATE OF id, "ownerId", "workspaceId" OR DELETE ON bots
FOR EACH ROW EXECUTE FUNCTION mikka_notify_mcp_reply_bot_scope();
