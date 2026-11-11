-- Display and cursor queries filter before LIMIT/aggregation. The original
-- Owner keeps their historical private transcript; a new reader receives only
-- independently proven shared events and clean model outputs.
CREATE FUNCTION mikka_bot_chat_display_message_visible(owner_id text,bot_id uuid,message_id uuid,viewer_id text)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE m coordinator_messages%ROWTYPE; source_id text; packet jsonb;
BEGIN
  SELECT * INTO m FROM coordinator_messages WHERE id=message_id AND "userId"=owner_id AND "botId"=bot_id;
  IF NOT FOUND THEN RETURN false; END IF;
  IF viewer_id=owner_id THEN RETURN true; END IF;
  IF mikka_bot_chat_message_visible(owner_id,bot_id,message_id) THEN RETURN true; END IF;
  -- Model messages cannot establish provenance using a JSON receipt id.
  IF m.message->>'role' IS DISTINCT FROM 'user' THEN RETURN false; END IF;
  source_id:=m.message#>>'{mikkaUserEvent,id}';
  IF source_id IS NULL AND jsonb_typeof(m.message#>'{mikkaEvent,packet}')='string' THEN
    BEGIN packet:=(m.message#>>'{mikkaEvent,packet}')::jsonb;
      source_id:=packet#>>'{source,messageId}';
    EXCEPTION WHEN invalid_text_representation THEN RETURN false; END;
  END IF;
  IF source_id IS NULL OR source_id !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RETURN false; END IF;
  RETURN mikka_bot_chat_event_visible(owner_id,bot_id,source_id::uuid);
END;
$$;

CREATE FUNCTION mikka_bot_chat_execution_visible(owner_id text,bot_id uuid,execution_key text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT mikka_bot_chat_owner_exclusive($1,$2) OR EXISTS(SELECT 1 FROM agent_kit_executions x
    JOIN bot_chat_submission_authorities a ON a."eventId"::text=x.snapshot#>>'{runtime,modelSelection,collaborationEventId}'
    WHERE x.owner_id=$1 AND x.bot_key=$2::text AND x.execution_key=$3
      AND x.snapshot->>'contextIsolation'='shared_clean' AND a."ownerId"=$1 AND a."botId"=$2
      AND a."contextIsolation"='shared_clean' AND a.mode='reply'
      AND NOT EXISTS(SELECT 1 FROM bot_chat_resource_reads r WHERE r."eventId"=a."eventId"
        AND NOT mikka_shared_bot_resource_visible(r."resourceKind",r."resourceId",r."workspaceId")));
$$;
