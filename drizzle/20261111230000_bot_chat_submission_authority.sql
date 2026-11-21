-- A contribution keeps the existing Coordinator event and transcript. This
-- receipt records authenticated provenance; no message or secret is copied.
CREATE TABLE bot_chat_submission_authorities (
  "eventId" uuid PRIMARY KEY REFERENCES coordinator_events(id) ON DELETE CASCADE,
  "ownerId" text NOT NULL,
  "actorId" text NOT NULL,
  "botId" uuid NOT NULL,
  "workspaceId" uuid NOT NULL,
  "principalKind" text NOT NULL CHECK ("principalKind" IN ('session','pat','oauth')),
  "principalId" text NOT NULL CHECK (length("principalId") BETWEEN 1 AND 512),
  mode text NOT NULL CHECK (mode IN ('comment','reply')),
  "contextIsolation" text NOT NULL CHECK ("contextIsolation" IN ('private','shared_clean')),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  "modelSnapshot" jsonb,
  "organizationId" uuid,
  "modelPolicyRevision" integer,
  "maxModelCalls" integer NOT NULL DEFAULT 0 CHECK ("maxModelCalls" BETWEEN 0 AND 64),
  "maxOutputTokens" integer NOT NULL DEFAULT 0 CHECK ("maxOutputTokens" BETWEEN 0 AND 16384),
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CHECK (CASE WHEN mode='reply' AND "contextIsolation"='shared_clean' THEN
    "modelSnapshot" IS NOT NULL AND "organizationId" IS NOT NULL AND "modelPolicyRevision" IS NOT NULL
      AND "maxModelCalls">0 AND "maxOutputTokens">0
    ELSE "modelSnapshot" IS NULL AND "organizationId" IS NULL AND "modelPolicyRevision" IS NULL
      AND "maxModelCalls"=0 AND "maxOutputTokens"=0 END)
);
CREATE INDEX bot_chat_authorities_actor ON bot_chat_submission_authorities("actorId","workspaceId","expiresAt");
CREATE INDEX bot_chat_authorities_principal ON bot_chat_submission_authorities("principalKind","principalId");
CREATE INDEX bot_chat_authorities_daily ON bot_chat_submission_authorities("organizationId","createdAt") WHERE mode='reply';

CREATE FUNCTION mikka_bot_chat_authority_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'bot_chat_authority_immutable' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM coordinator_events e JOIN bots b ON b.id=e."botId"
    WHERE e.id=NEW."eventId" AND e.kind='user_message' AND e."userId"=NEW."ownerId" AND e."botId"=NEW."botId"
      AND b."ownerId"=NEW."ownerId" AND b."workspaceId"=NEW."workspaceId")
    THEN RAISE EXCEPTION 'bot_chat_authority_mismatch' USING ERRCODE='23514'; END IF;
  IF NEW."modelSnapshot" IS NOT NULL AND (
    NEW."modelSnapshot"->>'type' IS DISTINCT FROM 'api_key' OR
    NEW."modelSnapshot"->>'ownerId' IS DISTINCT FROM NEW."ownerId" OR
    NEW."modelSnapshot"->>'actorId' IS DISTINCT FROM NEW."actorId" OR
    NEW."modelSnapshot"->>'consumerId' IS DISTINCT FROM NEW."botId"::text OR
    NEW."modelSnapshot"->>'workspaceId' IS DISTINCT FROM NEW."workspaceId"::text OR
    NEW."modelSnapshot"->>'organizationId' IS DISTINCT FROM NEW."organizationId"::text OR
    NEW."modelSnapshot"->>'credentialOwnerId' IS DISTINCT FROM 'organization:'||NEW."organizationId"::text OR
    NEW."modelSnapshot"->>'collaborationEventId' IS DISTINCT FROM NEW."eventId"::text)
    THEN RAISE EXCEPTION 'bot_chat_model_authority_mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bot_chat_authority_guard BEFORE INSERT OR UPDATE ON bot_chat_submission_authorities
  FOR EACH ROW EXECUTE FUNCTION mikka_bot_chat_authority_guard();

-- A Private Chat with any live non-owner content grant is collaborative too.
-- Unknown ancestry fails closed for personal context; it never gains an owner
-- capability merely because the leaf says Private.
CREATE FUNCTION mikka_bot_chat_owner_exclusive(owner_id text,bot_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM resource_access_policies p WHERE p.kind='chat'
    AND p.id=mikka_chat_resource_id(owner_id,bot_id) AND p."ownerId"=owner_id
    AND p.visibility='private' AND p."parentKind" IS NULL
    AND NOT EXISTS(SELECT 1 FROM resource_access_grants g WHERE g."resourceKind"='chat' AND g."resourceId"=p.id
      AND (g."subjectKind"<>'account' OR g."subjectId"<>owner_id)
      AND (g."expiresAt" IS NULL OR g."expiresAt">now())
      AND g.capabilities && ARRAY['canReadContent','canComment','canSteer']::text[]));
$$;
