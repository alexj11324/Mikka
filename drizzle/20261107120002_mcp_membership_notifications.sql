-- target: DATABASE_URL
-- Separate function/trigger names also permit the existing same-database setup.
CREATE OR REPLACE FUNCTION mikka_notify_mcp_reply_membership() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW."workspaceId", NEW."userId", NEW.status)
    IS NOT DISTINCT FROM (OLD."workspaceId", OLD."userId", OLD.status) THEN RETURN NULL; END IF;
  IF TG_OP <> 'INSERT' THEN
    PERFORM pg_notify('mikka_mcp_reply', 'member:' || OLD."workspaceId"::text || ':' || OLD."userId");
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM pg_notify('mikka_mcp_reply', 'member:' || NEW."workspaceId"::text || ':' || NEW."userId");
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER mcp_reply_membership_changed AFTER INSERT OR UPDATE OF "workspaceId", "userId", status OR DELETE ON mikka_workspace_members
FOR EACH ROW EXECUTE FUNCTION mikka_notify_mcp_reply_membership();
