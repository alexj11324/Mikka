-- target: MIKKA_DATABASE_URL
-- Only newly scoped exchanges are publishable. Existing private DMs/links are never imported.
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || '.conversation-exchange-scopes', 0));
CREATE TABLE IF NOT EXISTS conversation_exchange_scopes (
 "linkId" uuid PRIMARY KEY REFERENCES conversation_links(id),
 "sourceId" uuid NOT NULL REFERENCES conversations(id),
 "dmId" uuid NOT NULL UNIQUE REFERENCES conversations(id),
 "triggerMessageId" uuid NOT NULL REFERENCES conversation_messages(id),
 "anchorPosition" bigint NOT NULL,
 "requestedBy" text NOT NULL, "requesterJoinedAt" timestamptz NOT NULL,
 "agentA" uuid NOT NULL REFERENCES agents(id), "agentB" uuid NOT NULL REFERENCES agents(id),
 "grantA" uuid NOT NULL REFERENCES conversation_agent_grants(id), "grantB" uuid NOT NULL REFERENCES conversation_agent_grants(id),
 "joinedA" timestamptz NOT NULL, "joinedB" timestamptz NOT NULL,
 "revokedAt" timestamptz,
 CHECK ("agentA" < "agentB"), CHECK ("sourceId" <> "dmId")
);
CREATE INDEX IF NOT EXISTS conversation_exchange_source_idx ON conversation_exchange_scopes ("sourceId","anchorPosition");
CREATE TABLE IF NOT EXISTS conversation_exchange_messages (
 "messageId" uuid PRIMARY KEY REFERENCES conversation_messages(id),
 "linkId" uuid NOT NULL REFERENCES conversation_exchange_scopes("linkId"),
 "workId" uuid NOT NULL REFERENCES conversation_work(id),
 hash text NOT NULL
);
CREATE INDEX IF NOT EXISTS conversation_exchange_messages_link_idx ON conversation_exchange_messages ("linkId");
-- Preserve provenance even if a future writer accidentally tries to reparent a link.
CREATE OR REPLACE FUNCTION conversation_exchange_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME = 'conversation_exchange_scopes' THEN
  IF (to_jsonb(NEW)-'revokedAt') IS DISTINCT FROM (to_jsonb(OLD)-'revokedAt')
    OR (OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt") THEN
   RAISE EXCEPTION 'exchange scope is immutable';
  END IF;
 ELSE
  IF EXISTS (SELECT 1 FROM conversation_exchange_scopes WHERE "linkId"=OLD.id)
    AND (NEW.id,NEW."sourceConversationId",NEW."linkedConversationId",NEW."anchorPosition",NEW."firstPosition")
      IS DISTINCT FROM (OLD.id,OLD."sourceConversationId",OLD."linkedConversationId",OLD."anchorPosition",OLD."firstPosition") THEN
   RAISE EXCEPTION 'exchange link identity is immutable';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER conversation_exchange_scope_identity BEFORE UPDATE ON conversation_exchange_scopes
 FOR EACH ROW EXECUTE FUNCTION conversation_exchange_identity_guard();
CREATE OR REPLACE TRIGGER conversation_exchange_link_identity BEFORE UPDATE ON conversation_links
 FOR EACH ROW EXECUTE FUNCTION conversation_exchange_identity_guard();
