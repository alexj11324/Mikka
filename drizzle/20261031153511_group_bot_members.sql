-- target: MIKKA_DATABASE_URL
-- Bots are group chat identities; legacy coding agents remain separate.
SET LOCAL lock_timeout = '5s';
ALTER TABLE conversation_members DROP CONSTRAINT IF EXISTS "conversation_members_memberType_check";
ALTER TABLE conversation_members ADD CONSTRAINT "conversation_members_memberType_check" CHECK ("memberType" IN ('user','agent','bot'));
ALTER TABLE conversation_messages DROP CONSTRAINT IF EXISTS "conversation_messages_authorType_check";
ALTER TABLE conversation_messages ADD CONSTRAINT "conversation_messages_authorType_check" CHECK ("authorType" IN ('user','agent','bot'));
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS "leadBotId" uuid;
ALTER TABLE group_turns ADD COLUMN IF NOT EXISTS "botId" uuid;
ALTER TABLE group_turns ADD COLUMN IF NOT EXISTS "modelSelections" jsonb NOT NULL DEFAULT '{}';
