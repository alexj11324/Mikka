CREATE TABLE IF NOT EXISTS chat_attachments (
  id uuid PRIMARY KEY,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "botId" uuid REFERENCES bots(id) ON DELETE CASCADE,
  "conversationId" uuid REFERENCES conversations(id) ON DELETE CASCADE,
  "runId" uuid REFERENCES agent_runs(id) ON DELETE CASCADE,
  name text NOT NULL,
  "mediaType" text NOT NULL,
  size integer NOT NULL CHECK (size > 0 AND size <= 26214400),
  state text NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading', 'ready')),
  sha256 text,
  "storageKey" text,
  "uploadKey" text,
  "uploadExpiresAt" timestamptz,
  "inlineData" bytea,
  "textContent" text,
  "usedAt" timestamptz,
  "removedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_attachment_scope CHECK (num_nonnulls("botId", "conversationId", "runId") = 1),
  CONSTRAINT chat_attachment_storage CHECK (state <> 'ready' OR (sha256 IS NOT NULL AND num_nonnulls("storageKey", "inlineData") = 1))
);
CREATE INDEX IF NOT EXISTS chat_attachments_owner_idx ON chat_attachments ("userId", "createdAt");
CREATE INDEX IF NOT EXISTS chat_attachments_drafts_idx ON chat_attachments ("createdAt") WHERE "usedAt" IS NULL;

-- Object cleanup survives chat/account cascades and outstanding upload grants.
CREATE TABLE IF NOT EXISTS chat_attachment_retirements (
  "storageKey" text PRIMARY KEY,
  "userId" text NOT NULL,
  "notBefore" timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION retire_chat_attachment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."storageKey" IS NOT NULL THEN
    INSERT INTO chat_attachment_retirements("storageKey","userId") VALUES(OLD."storageKey",OLD."userId") ON CONFLICT DO NOTHING;
  END IF;
  IF OLD."uploadKey" IS NOT NULL THEN
    INSERT INTO chat_attachment_retirements("storageKey","userId","notBefore") VALUES(OLD."uploadKey",OLD."userId",coalesce(OLD."uploadExpiresAt",now())) ON CONFLICT DO NOTHING;
  END IF;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS retire_chat_attachment_files ON chat_attachments;
CREATE TRIGGER retire_chat_attachment_files AFTER DELETE ON chat_attachments FOR EACH ROW EXECUTE FUNCTION retire_chat_attachment();
DROP TRIGGER IF EXISTS account_deletion_insert_guard ON chat_attachments;
CREATE TRIGGER account_deletion_insert_guard BEFORE INSERT ON chat_attachments FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_insert('userId');
