-- Deferred from 20261111070001: this BEFORE INSERT trigger stands on
-- agent_kit_executions, which already exists. Enabling it before the shared
-- Bot chat code that registers a chat ACL row is deployed would refuse every
-- existing execution write (mikka_bot_chat_owner_exclusive finds no 'chat'
-- policy, so the guard rejects). It ships separately so the migrations can
-- land before their callers.
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
