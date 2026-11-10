-- Empty Bot chats need the same persistent ACL as chats with a session.
-- Register missing history conservatively; no existing visibility changes.
INSERT INTO resource_access_policies(kind,id,"workspaceId","ownerId",visibility,provenance)
SELECT 'chat',mikka_chat_resource_id(b."ownerId",b.id),b."workspaceId",b."ownerId",'private','legacy_private'
FROM bots b WHERE b."ownerId" IS NOT NULL ON CONFLICT(kind,id) DO NOTHING;

CREATE FUNCTION mikka_resource_acl_register_empty_chat() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."ownerId" IS NULL THEN RETURN NEW; END IF;
  INSERT INTO resource_access_policies(kind,id,"workspaceId","ownerId",visibility,provenance)
    VALUES('chat',mikka_chat_resource_id(NEW."ownerId",NEW.id),NEW."workspaceId",NEW."ownerId",'private','created')
    ON CONFLICT(kind,id) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER resource_acl_register_empty_chat AFTER INSERT ON bots
  FOR EACH ROW EXECUTE FUNCTION mikka_resource_acl_register_empty_chat();
