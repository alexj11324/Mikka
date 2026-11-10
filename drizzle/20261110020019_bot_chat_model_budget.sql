-- External provider requests are counted as capacity, never Mikka credits or
-- an invented monetary cost. Every started attempt consumes one bounded call.
CREATE TABLE bot_chat_model_calls (
  id uuid PRIMARY KEY,
  "eventId" uuid NOT NULL REFERENCES bot_chat_submission_authorities("eventId") ON DELETE CASCADE,
  "workflowId" text,
  "stepId" text,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bot_chat_model_calls_event ON bot_chat_model_calls("eventId");

-- A model may only inspect a resource whose entire inherited content boundary
-- is Workspace-shared. This remains safe when the Chat gains another reader.
CREATE FUNCTION mikka_shared_bot_resource_visible(resource_kind text,resource_id uuid,workspace_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH RECURSIVE ancestry AS (
    SELECT p.*,ARRAY[p.kind||':'||p.id::text] AS visited,0 AS depth FROM resource_access_policies p
      WHERE p.kind=resource_kind AND p.id=resource_id AND p."workspaceId"=workspace_id
    UNION ALL
    SELECT p.*,a.visited||(p.kind||':'||p.id::text),a.depth+1 FROM ancestry a
      JOIN resource_access_policies p ON p.kind=a."parentKind" AND p.id=a."parentId" AND p."workspaceId"=workspace_id
      WHERE a.depth<15 AND NOT (p.kind||':'||p.id::text)=ANY(a.visited)
  ) SELECT EXISTS(SELECT 1 FROM ancestry WHERE depth=0)
    AND NOT EXISTS(SELECT 1 FROM ancestry a WHERE a.visibility<>'shared' OR a."ownerId" IS NULL
      OR (a."parentKind" IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ancestry p WHERE p.kind=a."parentKind" AND p.id=a."parentId" AND p.depth=a.depth+1)));
$$;

CREATE FUNCTION mikka_bot_chat_event_source_visible(owner_id text,bot_id uuid,event_kind text,task_id uuid,run_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT mikka_bot_chat_owner_exclusive(owner_id,bot_id) OR EXISTS(SELECT 1 FROM bots b
    WHERE b.id=bot_id AND b."ownerId"=owner_id
      AND event_kind IN ('run_finished','run_question','run_blocked','issue_done','issue_status_changed')
      AND (task_id IS NOT NULL OR run_id IS NOT NULL)
      AND (task_id IS NULL OR mikka_shared_bot_resource_visible('task',task_id,b."workspaceId"))
      AND (run_id IS NULL OR mikka_shared_bot_resource_visible('thread',run_id,b."workspaceId")));
$$;

CREATE FUNCTION mikka_bot_chat_event_visible(owner_id text,bot_id uuid,event_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM coordinator_events e WHERE e.id=event_id AND e."userId"=owner_id AND e."botId"=bot_id
    AND (mikka_bot_chat_owner_exclusive(owner_id,bot_id)
      OR (e.kind='user_message' AND EXISTS(SELECT 1 FROM bot_chat_submission_authorities a
        WHERE a."eventId"=e.id AND a."ownerId"=owner_id AND a."botId"=bot_id AND a."contextIsolation"='shared_clean'))
      OR (e.kind<>'user_message' AND mikka_bot_chat_event_source_visible(owner_id,bot_id,e.kind,e."issueId",e."runId"))));
$$;

CREATE TABLE bot_chat_resource_reads (
  "eventId" uuid NOT NULL REFERENCES bot_chat_submission_authorities("eventId") ON DELETE CASCADE,
  "resourceKind" text NOT NULL CHECK("resourceKind" IN ('task','thread')),
  "resourceId" uuid NOT NULL,
  "workspaceId" uuid NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY("eventId","resourceKind","resourceId")
);
CREATE TABLE bot_chat_message_authorities (
  "messageId" uuid PRIMARY KEY REFERENCES coordinator_messages(id) ON DELETE CASCADE,
  "eventId" uuid NOT NULL REFERENCES bot_chat_submission_authorities("eventId") ON DELETE CASCADE,
  "executionId" uuid NOT NULL REFERENCES agent_kit_executions(id),
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION mikka_bot_chat_provenance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'bot_chat_provenance_immutable' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='bot_chat_message_authorities' THEN
    IF NOT EXISTS(SELECT 1 FROM coordinator_messages m
    JOIN agent_kit_executions x ON x.id=NEW."executionId" AND x.owner_id=m."userId" AND x.bot_key=m."botId"::text
    JOIN bot_chat_submission_authorities a ON a."eventId"=NEW."eventId" AND a."ownerId"=m."userId" AND a."botId"=m."botId"
    WHERE m.id=NEW."messageId" AND a."contextIsolation"='shared_clean' AND a.mode='reply'
      AND x.snapshot->>'contextIsolation'='shared_clean'
      AND x.snapshot#>>'{runtime,modelSelection,collaborationEventId}'=NEW."eventId"::text)
      THEN RAISE EXCEPTION 'bot_chat_message_authority_mismatch' USING ERRCODE='23514'; END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM bot_chat_submission_authorities a WHERE a."eventId"=NEW."eventId"
      AND a."workspaceId"=NEW."workspaceId" AND a."contextIsolation"='shared_clean' AND a.mode='reply'
      AND a."expiresAt">clock_timestamp()
      AND mikka_shared_bot_resource_visible(NEW."resourceKind",NEW."resourceId",NEW."workspaceId")
      AND mikka_resource_acl_allowed('account',a."actorId",a."workspaceId",NEW."resourceKind",NEW."resourceId",'canReadContent'))
      THEN RAISE EXCEPTION 'bot_chat_resource_authority_mismatch' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bot_chat_message_provenance_guard BEFORE INSERT OR UPDATE ON bot_chat_message_authorities
  FOR EACH ROW EXECUTE FUNCTION mikka_bot_chat_provenance_guard();
CREATE TRIGGER bot_chat_resource_provenance_guard BEFORE INSERT OR UPDATE ON bot_chat_resource_reads
  FOR EACH ROW EXECUTE FUNCTION mikka_bot_chat_provenance_guard();

CREATE FUNCTION mikka_bot_chat_message_visible(owner_id text,bot_id uuid,message_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM coordinator_messages m WHERE m.id=message_id AND m."userId"=owner_id AND m."botId"=bot_id
    AND (mikka_bot_chat_owner_exclusive(owner_id,bot_id) OR EXISTS(SELECT 1 FROM bot_chat_message_authorities a
      JOIN bot_chat_submission_authorities s ON s."eventId"=a."eventId" AND s."contextIsolation"='shared_clean'
      WHERE a."messageId"=m.id AND NOT EXISTS(SELECT 1 FROM bot_chat_resource_reads r WHERE r."eventId"=a."eventId"
        AND NOT mikka_shared_bot_resource_visible(r."resourceKind",r."resourceId",r."workspaceId")))));
$$;

CREATE FUNCTION mikka_shared_bot_execution_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b bots%ROWTYPE;
BEGIN
  SELECT * INTO b FROM bots WHERE id::text=NEW.bot_key AND "ownerId"=NEW.owner_id;
  IF NOT FOUND OR mikka_bot_chat_owner_exclusive(NEW.owner_id,b.id) THEN RETURN NEW; END IF;
  IF NEW.snapshot->>'contextIsolation' IS DISTINCT FROM 'shared_clean'
    OR jsonb_array_length(COALESCE(NEW.snapshot#>'{definition,skills}','[]'::jsonb))<>0
    OR COALESCE(NEW.snapshot#>>'{definition,instructions}','')<>''
    OR jsonb_array_length(COALESCE(NEW.snapshot#>'{personalPlugins,servers}','[]'::jsonb))<>0
    OR jsonb_array_length(COALESCE(NEW.snapshot#>'{personalPlugins,skills}','[]'::jsonb))<>0
    OR jsonb_array_length(COALESCE(NEW.snapshot#>'{personalPlugins,toolkits}','[]'::jsonb))<>0
    OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(NEW.snapshot->'effectiveTools','[]'::jsonb)) t(name)
      WHERE name NOT IN ('web_search','list_issues','get_issue','list_runs','get_run'))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(NEW.snapshot#>'{definition,tools}','[]'::jsonb)) t(name)
      WHERE name NOT IN ('web_search','list_issues','get_issue','list_runs','get_run'))
    OR NEW.snapshot#>>'{runtime,harness}' IS DISTINCT FROM 'ai_sdk'
    OR NOT EXISTS(SELECT 1 FROM bot_chat_submission_authorities a WHERE a."eventId"::text=NEW.snapshot#>>'{runtime,modelSelection,collaborationEventId}'
      AND a."ownerId"=NEW.owner_id AND a."botId"=b.id AND a."workspaceId"=b."workspaceId"
      AND a.mode='reply' AND a."contextIsolation"='shared_clean' AND a."expiresAt">now()
      AND a."modelSnapshot"=NEW.snapshot#>'{runtime,modelSelection}' AND a."actorId"=NEW.snapshot#>>'{runtime,actorId}')
    THEN RAISE EXCEPTION 'shared_bot_execution_authority_required' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER shared_bot_execution_guard BEFORE INSERT ON agent_kit_executions
  FOR EACH ROW EXECUTE FUNCTION mikka_shared_bot_execution_guard();

CREATE FUNCTION mikka_bot_chat_model_call_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE authority bot_chat_submission_authorities%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'bot_chat_model_call_immutable' USING ERRCODE='23514'; END IF;
  SELECT * INTO authority FROM bot_chat_submission_authorities WHERE "eventId"=NEW."eventId" FOR UPDATE;
  IF NOT FOUND OR authority.mode<>'reply' OR authority."contextIsolation"<>'shared_clean'
    OR authority."expiresAt"<=clock_timestamp()
    OR (SELECT count(*) FROM bot_chat_model_calls WHERE "eventId"=NEW."eventId")>=authority."maxModelCalls"
    THEN RAISE EXCEPTION 'bot_chat_model_call_budget_exhausted' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bot_chat_model_call_guard BEFORE INSERT OR UPDATE ON bot_chat_model_calls
  FOR EACH ROW EXECUTE FUNCTION mikka_bot_chat_model_call_guard();
