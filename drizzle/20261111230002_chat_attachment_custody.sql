-- target: MIKKA_DATABASE_URL
-- Attachment custody is the resource at upload time, not today's Bot owner.
-- A transfer cannot move a historical Chat or publish its files. Unknown
-- legacy rows retain NULL custody and are unreadable until explicitly repaired.
ALTER TABLE chat_attachments ADD COLUMN "workspaceId" uuid;
ALTER TABLE chat_attachments ADD COLUMN "resourceKind" text;
ALTER TABLE chat_attachments ADD COLUMN "resourceId" uuid;
ALTER TABLE chat_attachments ADD COLUMN "scopeOwnerId" text;
ALTER TABLE chat_attachments ADD CONSTRAINT chat_attachment_resource_custody CHECK (
  num_nonnulls("workspaceId","resourceKind","resourceId","scopeOwnerId")=0 OR
  (num_nonnulls("workspaceId","resourceKind","resourceId","scopeOwnerId")=4 AND "resourceKind" IN ('chat','thread','group')));

-- Uploads were owner-only before this migration. Only the uploader's original
-- Chat policy can establish historical Bot custody; a new Bot owner cannot.
INSERT INTO resource_access_policies(kind,id,"workspaceId","ownerId",visibility,provenance)
SELECT DISTINCT 'chat',mikka_chat_resource_id(a."userId",a."botId"),b."workspaceId",a."userId",'private','legacy_private'
FROM chat_attachments a JOIN bots b ON b.id=a."botId" AND b."ownerId"=a."userId"
WHERE a."botId" IS NOT NULL ON CONFLICT DO NOTHING;
UPDATE chat_attachments a SET "workspaceId"=p."workspaceId","resourceKind"='chat',"resourceId"=p.id,"scopeOwnerId"=a."userId"
FROM resource_access_policies p WHERE a."botId" IS NOT NULL AND p.kind='chat'
  AND p.id=mikka_chat_resource_id(a."userId",a."botId") AND p."ownerId"=a."userId"
  AND p."workspaceId" IS NOT NULL AND p.visibility<>'quarantined';
UPDATE chat_attachments a SET "workspaceId"=p."workspaceId","resourceKind"='thread',"resourceId"=p.id,"scopeOwnerId"=r."userId"
FROM agent_runs r JOIN resource_access_policies p ON p.kind='thread' AND p.id=r.id AND p."workspaceId"=r."workspaceId"
WHERE a."runId"=r.id AND r."userId"=a."userId" AND p."ownerId"=r."userId" AND p.visibility<>'quarantined';
UPDATE chat_attachments a SET "workspaceId"=c."workspaceId","resourceKind"='group',"resourceId"=c.id,"scopeOwnerId"=c."createdBy"
FROM conversations c WHERE a."conversationId"=c.id AND c.kind='group';
CREATE INDEX chat_attachments_resource_idx ON chat_attachments("workspaceId","resourceKind","resourceId");

CREATE FUNCTION mikka_chat_attachment_custody_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tenant uuid; resource_kind text; resource_id uuid; owner_id text;
BEGIN
  IF NEW."botId" IS NOT NULL THEN
    SELECT b."workspaceId",'chat',mikka_chat_resource_id(b."ownerId",b.id),b."ownerId"
      INTO tenant,resource_kind,resource_id,owner_id FROM bots b WHERE b.id=NEW."botId";
  ELSIF NEW."runId" IS NOT NULL THEN
    SELECT r."workspaceId",'thread',r.id,r."userId" INTO tenant,resource_kind,resource_id,owner_id
      FROM agent_runs r WHERE r.id=NEW."runId";
  ELSE
    SELECT c."workspaceId",'group',c.id,c."createdBy" INTO tenant,resource_kind,resource_id,owner_id
      FROM conversations c WHERE c.id=NEW."conversationId" AND c.kind='group';
  END IF;
  IF NEW."workspaceId" IS NULL THEN
    -- Rolling deployment compatibility only for the previous owner-only path.
    -- Unknown custody cannot be manufactured by a changed Bot owner.
    IF tenant IS NOT NULL AND owner_id IS NOT NULL AND (resource_kind='group' OR owner_id=NEW."userId") THEN
      NEW."workspaceId":=tenant;NEW."resourceKind":=resource_kind;NEW."resourceId":=resource_id;NEW."scopeOwnerId":=owner_id;
    END IF;
  ELSIF ROW(NEW."workspaceId",NEW."resourceKind",NEW."resourceId",NEW."scopeOwnerId")
      IS DISTINCT FROM ROW(tenant,resource_kind,resource_id,owner_id) THEN
    RAISE EXCEPTION 'chatAttachmentScopeMismatch' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER chat_attachment_custody_insert BEFORE INSERT ON chat_attachments
FOR EACH ROW EXECUTE FUNCTION mikka_chat_attachment_custody_insert();

CREATE FUNCTION mikka_chat_attachment_custody_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."workspaceId",NEW."resourceKind",NEW."resourceId",NEW."scopeOwnerId",NEW."userId",NEW."botId",NEW."runId",NEW."conversationId")
    IS DISTINCT FROM ROW(OLD."workspaceId",OLD."resourceKind",OLD."resourceId",OLD."scopeOwnerId",OLD."userId",OLD."botId",OLD."runId",OLD."conversationId") THEN
    RAISE EXCEPTION 'chatAttachmentCustodyImmutable' USING ERRCODE='55000';
  END IF;
  IF OLD."usedAt" IS NOT NULL AND NEW."usedAt" IS DISTINCT FROM OLD."usedAt" THEN
    RAISE EXCEPTION 'chatAttachmentUseImmutable' USING ERRCODE='55000';
  END IF;
  IF OLD.state='ready' AND ROW(NEW.state,NEW.name,NEW."mediaType",NEW.size,NEW.sha256,NEW."storageKey",NEW."inlineData",NEW."textContent")
    IS DISTINCT FROM ROW(OLD.state,OLD.name,OLD."mediaType",OLD.size,OLD.sha256,OLD."storageKey",OLD."inlineData",OLD."textContent") THEN
    RAISE EXCEPTION 'chatAttachmentContentImmutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER chat_attachment_custody_immutable BEFORE UPDATE ON chat_attachments
FOR EACH ROW EXECUTE FUNCTION mikka_chat_attachment_custody_immutable();

-- A private source is safe only when the target remains below that exact ACL.
-- Comparing just today's member list would disclose the source to tomorrow's
-- new members. A separate Shared source can later become private, so it is
-- not copied into an unrelated Thread whose policy cannot revoke that output.
CREATE FUNCTION mikka_chat_attachment_flows_to(tenant uuid,source_kind text,source_id uuid,target_kind text,target_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
WITH RECURSIVE ancestry AS (
  SELECT kind,id,"workspaceId",visibility,"parentKind","parentId",0 AS depth,ARRAY[kind||':'||id::text] AS path,false AS cycle,side
    FROM (VALUES ('source',source_kind,source_id),('target',target_kind,target_id)) roots(side,root_kind,root_id)
    JOIN resource_access_policies p ON p.kind=roots.root_kind AND p.id=roots.root_id
  UNION ALL
  SELECT p.kind,p.id,p."workspaceId",p.visibility,p."parentKind",p."parentId",a.depth+1,a.path||(p.kind||':'||p.id::text),
    (p.kind||':'||p.id::text)=ANY(a.path),a.side
    FROM ancestry a JOIN resource_access_policies p ON p.kind=a."parentKind" AND p.id=a."parentId"
    WHERE a.depth<32 AND NOT a.cycle
)
SELECT EXISTS(SELECT 1 FROM ancestry WHERE side='source' AND depth=0)
  AND EXISTS(SELECT 1 FROM ancestry WHERE side='target' AND depth=0)
  AND NOT EXISTS(SELECT 1 FROM ancestry a WHERE a."workspaceId" IS DISTINCT FROM tenant OR a.visibility='quarantined' OR a.cycle OR a.depth>=32
    OR (a."parentId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ancestry parent WHERE parent.side=a.side AND parent.kind=a."parentKind" AND parent.id=a."parentId")))
  AND EXISTS(SELECT 1 FROM ancestry WHERE side='target' AND kind=source_kind AND id=source_id);
$$;
