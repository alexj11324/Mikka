-- target: MIKKA_DATABASE_URL

-- APP cannot infer Workspace kind across the database boundary. New and
-- rebound resources fail closed; authoritative Team writers register sharing
-- explicitly before their APP transaction commits. Existing grants are intact.
CREATE OR REPLACE FUNCTION mikka_resource_acl_register() RETURNS trigger LANGUAGE plpgsql AS $$
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
  access_mode:=CASE WHEN NEW."workspaceId" IS NULL THEN 'quarantined' ELSE 'private' END;
  INSERT INTO resource_access_policies(kind,id,"workspaceId","ownerId",visibility,"parentKind","parentId",provenance)
    VALUES(resource_kind,NEW.id,NEW."workspaceId",owner_id,access_mode,parent_kind,parent_id,CASE WHEN TG_OP='INSERT' THEN 'created' ELSE 'legacy_private' END)
    ON CONFLICT(kind,id) DO NOTHING;
  -- A trusted historical tenant backfill may resolve quarantine, but it never
  -- publishes an old private transcript or artifact. Task sharing is separate.
  UPDATE resource_access_policies SET "workspaceId"=NEW."workspaceId","ownerId"=owner_id,
    visibility='private',
    provenance='legacy_private'
    WHERE kind=resource_kind AND id=NEW.id AND "workspaceId" IS NULL AND NEW."workspaceId" IS NOT NULL;
  RETURN NEW;
END;
$$;
