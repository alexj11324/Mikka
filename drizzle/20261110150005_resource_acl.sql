-- Application-local resource authorization. Workspace/Enterprise membership is
-- independently authoritative in DATABASE_URL and is checked before this ACL.
-- There is deliberately no cross-database foreign key or membership copy.
CREATE TABLE resource_access_policies (
  kind text NOT NULL CHECK (kind IN ('project','task','thread','bot','chat','artifact')),
  id uuid NOT NULL,
  "workspaceId" uuid,
  "ownerId" text,
  visibility text NOT NULL CHECK (visibility IN ('shared','private','quarantined')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  "parentKind" text,
  "parentId" uuid,
  provenance text NOT NULL CHECK (provenance IN ('legacy_shared_task','legacy_private','legacy_shared_project','legacy_private_project','created','quarantined')),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind,id),
  CHECK (("parentKind" IS NULL) = ("parentId" IS NULL)),
  CHECK (visibility='quarantined' OR "workspaceId" IS NOT NULL),
  CHECK ("parentKind" IS NULL OR "parentKind" IN ('project','task','thread','bot','chat')),
  CHECK ("parentKind" IS NULL OR (kind,id) <> ("parentKind","parentId"))
);
CREATE INDEX resource_access_workspace_idx ON resource_access_policies ("workspaceId",kind,id);
CREATE INDEX resource_access_parent_idx ON resource_access_policies ("parentKind","parentId");

CREATE TABLE resource_access_grants (
  "resourceKind" text NOT NULL,
  "resourceId" uuid NOT NULL,
  "subjectKind" text NOT NULL CHECK ("subjectKind" IN ('account','service')),
  "subjectId" text NOT NULL,
  capabilities text[] NOT NULL,
  "expiresAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("resourceKind","resourceId","subjectKind","subjectId"),
  FOREIGN KEY ("resourceKind","resourceId") REFERENCES resource_access_policies(kind,id) ON DELETE CASCADE,
  CHECK (cardinality(capabilities)>0 AND capabilities <@ ARRAY['canDiscover','canReadMetadata','canReadContent','canComment','canSteer','canApprove','canManageAccess','canTransfer','canUseCredential','canUseMachine','canViewUsage','canViewBilling']::text[])
);
CREATE INDEX resource_access_subject_idx ON resource_access_grants ("subjectKind","subjectId","resourceKind","resourceId");

CREATE TABLE resource_access_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "resourceKind" text NOT NULL,
  "resourceId" uuid NOT NULL,
  "workspaceId" uuid,
  "actorId" text NOT NULL,
  "ownerId" text,
  revision integer NOT NULL,
  source text NOT NULL,
  action text NOT NULL,
  detail jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX resource_access_events_resource_idx ON resource_access_events ("resourceKind","resourceId","createdAt");

CREATE FUNCTION mikka_resource_acl_allowed(subject_kind text, subject_id text, tenant uuid, resource_kind text, resource_id uuid, requested_action text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH RECURSIVE ancestry AS (
    SELECT p.*,0 AS depth,ARRAY[p.kind||':'||p.id::text] AS path,false AS cycle
    FROM resource_access_policies p WHERE p.kind=resource_kind AND p.id=resource_id
    UNION ALL
    SELECT p.*,a.depth+1,a.path||(p.kind||':'||p.id::text),(p.kind||':'||p.id::text)=ANY(a.path)
    FROM ancestry a JOIN resource_access_policies p ON p.kind=a."parentKind" AND p.id=a."parentId"
    WHERE a.depth<32 AND NOT a.cycle
  ), decisions AS (
    SELECT a.*,CASE WHEN depth=0 THEN requested_action
      WHEN requested_action IN ('canComment','canSteer') THEN requested_action ELSE 'canReadContent' END AS action
    FROM ancestry a
  )
  SELECT tenant IS NOT NULL AND subject_id IS NOT NULL AND subject_kind IN ('account','service')
    AND requested_action=ANY(ARRAY['canDiscover','canReadMetadata','canReadContent','canComment','canSteer','canApprove','canManageAccess','canTransfer','canUseCredential','canUseMachine','canViewUsage','canViewBilling'])
    AND EXISTS(SELECT 1 FROM ancestry WHERE depth=0)
    AND NOT EXISTS(SELECT 1 FROM decisions d WHERE d.cycle OR d.depth>=32 OR d."workspaceId" IS DISTINCT FROM tenant
      OR d.visibility='quarantined'
      OR (d."parentId" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM resource_access_policies parent WHERE parent.kind=d."parentKind" AND parent.id=d."parentId"))
      OR NOT coalesce((
        -- Neither ownership nor sharing authorizes personal credentials,
        -- machines or a billing account. Those require their separate grants.
        (subject_kind='account' AND d."ownerId"=subject_id AND d.action=ANY(ARRAY['canDiscover','canReadMetadata','canReadContent','canComment','canSteer','canApprove','canManageAccess','canTransfer','canViewUsage']))
        OR (subject_kind='account' AND d.visibility='shared' AND d.action=ANY(ARRAY['canDiscover','canReadMetadata','canReadContent','canComment','canSteer']))
        OR EXISTS(SELECT 1 FROM resource_access_grants g WHERE g."resourceKind"=d.kind AND g."resourceId"=d.id
          AND g."subjectKind"=subject_kind AND g."subjectId"=subject_id AND (g."expiresAt" IS NULL OR g."expiresAt">statement_timestamp())
          AND (d.action=ANY(g.capabilities) OR (d.action IN ('canDiscover','canReadMetadata') AND 'canReadContent'=ANY(g.capabilities))))
      ),false));
$$;

CREATE FUNCTION mikka_resource_acl_policy_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous jsonb := '{}'::jsonb;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (NEW.kind,NEW.id) IS DISTINCT FROM (OLD.kind,OLD.id) OR (OLD."workspaceId" IS NOT NULL AND NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId") THEN
      RAISE EXCEPTION 'resource_scope_immutable' USING ERRCODE='23514';
    END IF;
    NEW.revision := OLD.revision+1;
    NEW."updatedAt" := clock_timestamp();
    previous := jsonb_build_object('previousOwnerId',OLD."ownerId",'previousVisibility',OLD.visibility,'previousParentKind',OLD."parentKind",'previousParentId',OLD."parentId");
  END IF;
  INSERT INTO resource_access_events("resourceKind","resourceId","workspaceId","actorId","ownerId",revision,source,action,detail)
  VALUES(NEW.kind,NEW.id,NEW."workspaceId",coalesce(nullif(current_setting('mikka.acl_actor',true),''),'system'),NEW."ownerId",NEW.revision,
    coalesce(nullif(current_setting('mikka.acl_source',true),''),'resource_registration'),lower(TG_OP),
    previous||jsonb_build_object('visibility',NEW.visibility,'parentKind',NEW."parentKind",'parentId',NEW."parentId",'provenance',NEW.provenance));
  RETURN NEW;
END;
$$;
CREATE TRIGGER resource_acl_policy_change BEFORE INSERT OR UPDATE ON resource_access_policies FOR EACH ROW EXECUTE FUNCTION mikka_resource_acl_policy_change();

CREATE FUNCTION mikka_resource_acl_policy_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO resource_access_events("resourceKind","resourceId","workspaceId","actorId","ownerId",revision,source,action,detail)
  VALUES(OLD.kind,OLD.id,OLD."workspaceId",coalesce(nullif(current_setting('mikka.acl_actor',true),''),'system'),OLD."ownerId",OLD.revision,
    coalesce(nullif(current_setting('mikka.acl_source',true),''),'source_deleted'),'delete',jsonb_build_object('visibility',OLD.visibility));
  RETURN OLD;
END;
$$;
CREATE TRIGGER resource_acl_policy_delete BEFORE DELETE ON resource_access_policies FOR EACH ROW EXECUTE FUNCTION mikka_resource_acl_policy_delete();

CREATE FUNCTION mikka_resource_acl_grant_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item record; policy record;
BEGIN
  IF TG_OP='DELETE' THEN item:=OLD; ELSE item:=NEW; END IF;
  -- Direct SQL grant writers participate in the same lease as application
  -- writers. A revocation cannot commit during an authorized content write.
  UPDATE resource_access_policies SET revision=revision WHERE kind=item."resourceKind" AND id=item."resourceId" RETURNING * INTO policy;
  INSERT INTO resource_access_events("resourceKind","resourceId","workspaceId","actorId","ownerId",revision,source,action,detail)
  VALUES(item."resourceKind",item."resourceId",policy."workspaceId",coalesce(nullif(current_setting('mikka.acl_actor',true),''),'system'),policy."ownerId",coalesce(policy.revision,1),
    coalesce(nullif(current_setting('mikka.acl_source',true),''),'resource_registration'),'grant_'||lower(TG_OP),
    jsonb_build_object('subjectKind',item."subjectKind",'subjectId',item."subjectId",'capabilities',item.capabilities,'expiresAt',item."expiresAt"));
  RETURN item;
END;
$$;
CREATE TRIGGER resource_acl_grant_change AFTER INSERT OR UPDATE OR DELETE ON resource_access_grants FOR EACH ROW EXECUTE FUNCTION mikka_resource_acl_grant_change();

CREATE FUNCTION mikka_resource_acl_immutable_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'resource_audit_immutable' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER resource_acl_immutable_event BEFORE UPDATE OR DELETE ON resource_access_events FOR EACH ROW EXECUTE FUNCTION mikka_resource_acl_immutable_event();

-- Preserve already-bound Task collaboration. Do not infer its tenant from a
-- creator, an old scope string, an invitation or the current Workspace.
INSERT INTO resource_access_policies(kind,id,"workspaceId","ownerId",visibility,provenance)
SELECT 'task',id,"workspaceId","userId",CASE WHEN "ownershipState"='bound' THEN 'shared' ELSE 'quarantined' END,
  CASE WHEN "ownershipState"='bound' THEN 'legacy_shared_task' ELSE 'quarantined' END FROM issues;
INSERT INTO resource_access_policies(kind,id,"workspaceId","ownerId",visibility,"parentKind","parentId",provenance)
SELECT 'thread',id,"workspaceId","userId",CASE WHEN "workspaceId" IS NULL THEN 'quarantined' ELSE 'private' END,
  CASE WHEN "issueId" IS NOT NULL THEN 'task' END,"issueId",'legacy_private' FROM agent_runs;
INSERT INTO resource_access_policies(kind,id,"workspaceId","ownerId",visibility,provenance)
SELECT 'bot',id,"workspaceId","ownerId",'private','legacy_private' FROM bots;
INSERT INTO resource_access_policies(kind,id,"workspaceId","ownerId",visibility,"parentKind","parentId",provenance)
SELECT 'artifact',id,"workspaceId","userId",CASE WHEN "workspaceId" IS NULL THEN 'quarantined' ELSE 'private' END,
  CASE WHEN "runId" IS NOT NULL THEN 'thread' WHEN "issueId" IS NOT NULL THEN 'task' END,coalesce("runId","issueId"),'legacy_private' FROM artifacts;

CREATE FUNCTION mikka_chat_resource_id(owner_id text, bot_id uuid) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT substr(encode(sha256(convert_to(owner_id||':'||coalesce(bot_id::text,'coordinator'),'UTF8')),'hex'),1,32)::uuid;
$$;
INSERT INTO resource_access_policies(kind,id,"workspaceId","ownerId",visibility,provenance)
SELECT 'chat',mikka_chat_resource_id(s."userId",s."botId"),b."workspaceId",s."userId",CASE WHEN b."workspaceId" IS NULL THEN 'quarantined' ELSE 'private' END,'legacy_private'
FROM coordinator_sessions s LEFT JOIN bots b ON b.id=s."botId";

CREATE FUNCTION mikka_resource_acl_register() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE resource_kind text; owner_id text; parent_kind text; parent_id uuid; access_mode text;
BEGIN
  resource_kind:=CASE TG_TABLE_NAME WHEN 'issues' THEN 'task' WHEN 'agent_runs' THEN 'thread' WHEN 'bots' THEN 'bot' ELSE 'artifact' END;
  IF TG_TABLE_NAME='bots' THEN owner_id:=NEW."ownerId"; ELSE owner_id:=NEW."userId"; END IF;
  IF TG_TABLE_NAME='agent_runs' THEN
    SELECT 'thread',r.id INTO parent_kind,parent_id FROM agent_runs r
      WHERE r.id=coalesce(NEW."continuesRunId",NEW."retryOf",CASE WHEN NEW."questionContinuation"->>'originRunId' ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN (NEW."questionContinuation"->>'originRunId')::uuid END) AND r."userId"=NEW."userId"
        AND r."workspaceId"=NEW."workspaceId" AND r."issueId" IS NOT DISTINCT FROM NEW."issueId";
    IF parent_id IS NULL AND NEW."issueId" IS NOT NULL THEN parent_kind:='task';parent_id:=NEW."issueId"; END IF;
  END IF;
  IF TG_TABLE_NAME='artifacts' THEN
    parent_kind:=CASE WHEN NEW."runId" IS NOT NULL THEN 'thread' WHEN NEW."issueId" IS NOT NULL THEN 'task' END;
    parent_id:=coalesce(NEW."runId",NEW."issueId");
  END IF;
  access_mode:=CASE WHEN NEW."workspaceId" IS NULL THEN 'quarantined' WHEN TG_TABLE_NAME='issues' THEN 'shared' ELSE 'private' END;
  INSERT INTO resource_access_policies(kind,id,"workspaceId","ownerId",visibility,"parentKind","parentId",provenance)
    VALUES(resource_kind,NEW.id,NEW."workspaceId",owner_id,access_mode,parent_kind,parent_id,CASE WHEN TG_OP='INSERT' THEN 'created' ELSE 'legacy_private' END)
    ON CONFLICT(kind,id) DO NOTHING;
  -- A trusted historical tenant backfill may resolve quarantine, but it never
  -- publishes an old private transcript or artifact. Task sharing is separate.
  UPDATE resource_access_policies SET "workspaceId"=NEW."workspaceId","ownerId"=owner_id,
    visibility=CASE WHEN resource_kind='task' THEN 'shared' ELSE 'private' END,
    provenance=CASE WHEN resource_kind='task' THEN 'legacy_shared_task' ELSE 'legacy_private' END
    WHERE kind=resource_kind AND id=NEW.id AND "workspaceId" IS NULL AND NEW."workspaceId" IS NOT NULL;
  RETURN NEW;
END;
$$;
CREATE TRIGGER resource_acl_register_task AFTER INSERT OR UPDATE OF "workspaceId" ON issues FOR EACH ROW EXECUTE FUNCTION mikka_resource_acl_register();
CREATE TRIGGER resource_acl_register_thread AFTER INSERT OR UPDATE OF "workspaceId" ON agent_runs FOR EACH ROW EXECUTE FUNCTION mikka_resource_acl_register();
CREATE TRIGGER resource_acl_register_bot AFTER INSERT ON bots FOR EACH ROW EXECUTE FUNCTION mikka_resource_acl_register();
CREATE TRIGGER resource_acl_register_artifact AFTER INSERT OR UPDATE OF "workspaceId" ON artifacts FOR EACH ROW EXECUTE FUNCTION mikka_resource_acl_register();

CREATE FUNCTION mikka_resource_acl_register_chat() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tenant uuid;
BEGIN
  SELECT "workspaceId" INTO tenant FROM bots WHERE id=NEW."botId";
  INSERT INTO resource_access_policies(kind,id,"workspaceId","ownerId",visibility,provenance)
    VALUES('chat',mikka_chat_resource_id(NEW."userId",NEW."botId"),tenant,NEW."userId",CASE WHEN tenant IS NULL THEN 'quarantined' ELSE 'private' END,'created') ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER resource_acl_register_chat AFTER INSERT ON coordinator_sessions FOR EACH ROW EXECUTE FUNCTION mikka_resource_acl_register_chat();

-- A source deletion retires authority with its source. Retained shared rows
-- keep their ACL; generic account cleanup must not delete these by ownerId.
CREATE FUNCTION mikka_resource_acl_delete_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE resource_kind text; resource_id uuid;
BEGIN
  resource_kind:=CASE TG_TABLE_NAME WHEN 'issues' THEN 'task' WHEN 'agent_runs' THEN 'thread' WHEN 'bots' THEN 'bot' WHEN 'coordinator_sessions' THEN 'chat' ELSE 'artifact' END;
  IF TG_TABLE_NAME='coordinator_sessions' THEN resource_id:=mikka_chat_resource_id(OLD."userId",OLD."botId"); ELSE resource_id:=OLD.id; END IF;
  DELETE FROM resource_access_policies WHERE kind=resource_kind AND id=resource_id;
  RETURN OLD;
END;
$$;
CREATE TRIGGER resource_acl_delete_task AFTER DELETE ON issues FOR EACH ROW EXECUTE FUNCTION mikka_resource_acl_delete_source();
CREATE TRIGGER resource_acl_delete_thread AFTER DELETE ON agent_runs FOR EACH ROW EXECUTE FUNCTION mikka_resource_acl_delete_source();
CREATE TRIGGER resource_acl_delete_bot AFTER DELETE ON bots FOR EACH ROW EXECUTE FUNCTION mikka_resource_acl_delete_source();
CREATE TRIGGER resource_acl_delete_artifact AFTER DELETE ON artifacts FOR EACH ROW EXECUTE FUNCTION mikka_resource_acl_delete_source();
CREATE TRIGGER resource_acl_delete_chat AFTER DELETE ON coordinator_sessions FOR EACH ROW EXECUTE FUNCTION mikka_resource_acl_delete_source();
