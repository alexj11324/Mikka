-- target: MIKKA_DATABASE_URL
-- 20017 registers authority before a Bot has a Session. Retire that empty
-- authority when its source is deleted; never remove retained conversation
-- content or relax the immutable audit/deletion-custody guards.
CREATE FUNCTION mikka_resource_acl_delete_empty_chat() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."ownerId" IS NULL THEN RETURN OLD; END IF;
  DELETE FROM resource_access_policies p
    WHERE p.kind='chat' AND p.id=mikka_chat_resource_id(OLD."ownerId",OLD.id)
      AND p."ownerId"=OLD."ownerId"
      AND NOT EXISTS(SELECT 1 FROM coordinator_sessions s WHERE s."userId"=OLD."ownerId" AND s."botId"=OLD.id)
      AND NOT EXISTS(SELECT 1 FROM coordinator_messages m WHERE m."userId"=OLD."ownerId" AND m."botId"=OLD.id)
      AND NOT EXISTS(SELECT 1 FROM coordinator_events e WHERE e."userId"=OLD."ownerId" AND e."botId"=OLD.id);
  RETURN OLD;
END;
$$;
CREATE TRIGGER resource_acl_retire_empty_chat AFTER DELETE ON bots
  FOR EACH ROW EXECUTE FUNCTION mikka_resource_acl_delete_empty_chat();
