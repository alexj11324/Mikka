-- target: MIKKA_DATABASE_URL
-- Additive, replayable. Existing history is retained; old agent memberships have no
-- grant and remain inert until their owner explicitly grants this conversation.
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || '.group-artifact-review', 0));
CREATE TABLE IF NOT EXISTS conversation_agent_grants (
 id uuid PRIMARY KEY, "conversationId" uuid NOT NULL REFERENCES conversations(id),
 "agentId" uuid NOT NULL, "ownerId" text NOT NULL,
 "createdAt" timestamptz NOT NULL DEFAULT now(), "revokedAt" timestamptz,
 UNIQUE ("conversationId",id)
);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_agent_grants_live ON conversation_agent_grants ("conversationId","agentId") WHERE "revokedAt" IS NULL;
CREATE TABLE IF NOT EXISTS conversation_message_keys (
 "conversationId" uuid NOT NULL REFERENCES conversations(id), "userId" text NOT NULL,
 key uuid NOT NULL, hash text NOT NULL, "messageId" uuid NOT NULL,
 PRIMARY KEY ("conversationId","userId",key),
 FOREIGN KEY ("conversationId","messageId") REFERENCES conversation_messages("conversationId",id)
);
CREATE TABLE IF NOT EXISTS conversation_work (
 id uuid PRIMARY KEY, "conversationId" uuid NOT NULL REFERENCES conversations(id),
 "triggerMessageId" uuid NOT NULL, "agentId" uuid NOT NULL,
 "grantId" uuid NOT NULL, "requestedBy" text NOT NULL, "requesterJoinedAt" timestamptz NOT NULL,
 "agentJoinedAt" timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','dispatched','completed','cancelled','conflict')),
 "runId" uuid UNIQUE, "replyMessageId" uuid, "createdAt" timestamptz NOT NULL DEFAULT now(),
 UNIQUE ("conversationId",id), UNIQUE ("triggerMessageId","agentId"),
 FOREIGN KEY ("conversationId","triggerMessageId") REFERENCES conversation_messages("conversationId",id),
 FOREIGN KEY ("conversationId","grantId") REFERENCES conversation_agent_grants("conversationId",id),
 FOREIGN KEY ("conversationId","replyMessageId") REFERENCES conversation_messages("conversationId",id)
);
CREATE INDEX IF NOT EXISTS conversation_work_pending ON conversation_work(status,"createdAt");
CREATE TABLE IF NOT EXISTS artifacts (
 id uuid PRIMARY KEY, "conversationId" uuid NOT NULL REFERENCES conversations(id),
 title text NOT NULL, "mediaType" text NOT NULL CHECK ("mediaType" IN ('text/markdown','text/html','text/plain')),
 "currentAgentId" uuid NOT NULL, "headVersionId" uuid, "acceptedVersionId" uuid,
 "createdBy" text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
 UNIQUE ("conversationId",id)
);
CREATE TABLE IF NOT EXISTS artifact_versions (
 id uuid PRIMARY KEY, "artifactId" uuid NOT NULL REFERENCES artifacts(id),
 "baseVersionId" uuid, content text NOT NULL, hash text NOT NULL CHECK (hash ~ '^[a-f0-9]{64}$'),
 "authorType" text NOT NULL CHECK ("authorType" IN ('user','agent')), "authorId" text NOT NULL,
 "workId" uuid UNIQUE REFERENCES conversation_work(id), "createdAt" timestamptz NOT NULL DEFAULT now(),
 UNIQUE ("artifactId",id), UNIQUE ("artifactId",id,hash),
 FOREIGN KEY ("artifactId","baseVersionId") REFERENCES artifact_versions("artifactId",id)
);
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='artifacts_head_version_fk' AND conrelid='artifacts'::regclass) THEN
  ALTER TABLE artifacts ADD CONSTRAINT artifacts_head_version_fk FOREIGN KEY (id,"headVersionId") REFERENCES artifact_versions("artifactId",id);
  ALTER TABLE artifacts ADD CONSTRAINT artifacts_accepted_version_fk FOREIGN KEY (id,"acceptedVersionId") REFERENCES artifact_versions("artifactId",id);
 END IF;
END $$;
CREATE OR REPLACE FUNCTION reject_artifact_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'Artifact versions are immutable';
END $$;
DROP TRIGGER IF EXISTS artifact_versions_immutable ON artifact_versions;
CREATE TRIGGER artifact_versions_immutable BEFORE UPDATE OR DELETE ON artifact_versions FOR EACH ROW EXECUTE FUNCTION reject_artifact_version_mutation();
CREATE TABLE IF NOT EXISTS artifact_threads (
 id uuid PRIMARY KEY, "artifactId" uuid NOT NULL REFERENCES artifacts(id), "versionId" uuid NOT NULL,
 anchor jsonb NOT NULL, "createdBy" text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
 UNIQUE ("artifactId",id), FOREIGN KEY ("artifactId","versionId") REFERENCES artifact_versions("artifactId",id)
);
CREATE TABLE IF NOT EXISTS artifact_comments (
 id uuid PRIMARY KEY, "threadId" uuid NOT NULL REFERENCES artifact_threads(id),
 "authorType" text NOT NULL CHECK ("authorType" IN ('user','agent')), "authorId" text NOT NULL,
 body text NOT NULL, "workId" uuid UNIQUE REFERENCES conversation_work(id), "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS artifact_change_requests (
 id uuid PRIMARY KEY, "artifactId" uuid NOT NULL, "threadId" uuid NOT NULL,
 "baseVersionId" uuid NOT NULL, "workId" uuid NOT NULL UNIQUE REFERENCES conversation_work(id),
 FOREIGN KEY ("artifactId","threadId") REFERENCES artifact_threads("artifactId",id),
 FOREIGN KEY ("artifactId","baseVersionId") REFERENCES artifact_versions("artifactId",id)
);
CREATE TABLE IF NOT EXISTS artifact_acceptances (
 "artifactId" uuid NOT NULL REFERENCES artifacts(id), "versionId" uuid NOT NULL, hash text NOT NULL,
 "userId" text NOT NULL, "acceptedAt" timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY ("artifactId","versionId","userId"),
 FOREIGN KEY ("artifactId","versionId",hash) REFERENCES artifact_versions("artifactId",id,hash)
);
