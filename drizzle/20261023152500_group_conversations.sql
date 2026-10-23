-- target: MIKKA_DATABASE_URL
-- MIK-11/12. Additive tables only; normal implicit transaction, no existing-table scans.
-- Production build applies this migration. IF NOT EXISTS makes retries safe.
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS conversations (
 id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('group','agent_dm')), title text NOT NULL,
 "createdBy" text NOT NULL, "lastPosition" bigint NOT NULL DEFAULT 0 CHECK ("lastPosition" >= 0),
 "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS conversation_members (
 "conversationId" uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 "memberType" text NOT NULL CHECK ("memberType" IN ('user','agent')), "memberId" text NOT NULL,
 role text NOT NULL CHECK (role IN ('owner','member')), "joinedAt" timestamptz NOT NULL DEFAULT now(), "leftAt" timestamptz,
 PRIMARY KEY ("conversationId","memberType","memberId")
);
CREATE INDEX IF NOT EXISTS conversation_members_identity_idx ON conversation_members ("memberType","memberId");
CREATE TABLE IF NOT EXISTS conversation_messages (
 id uuid PRIMARY KEY, "conversationId" uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 position bigint NOT NULL CHECK (position > 0), "authorType" text NOT NULL CHECK ("authorType" IN ('user','agent')),
 "authorId" text NOT NULL, body text NOT NULL, mentions jsonb NOT NULL DEFAULT '[]',
 "replyToId" uuid, "createdAt" timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT conversation_messages_position_key UNIQUE ("conversationId",position),
 UNIQUE ("conversationId", id),
 FOREIGN KEY ("conversationId", "replyToId") REFERENCES conversation_messages("conversationId",id)
);
CREATE INDEX IF NOT EXISTS conversation_messages_timeline_idx ON conversation_messages ("conversationId",position DESC);
-- Compatible with #69. No conversation FK: coordinator uses a non-UUID identifier.
CREATE TABLE IF NOT EXISTS conversation_reads (
 "userId" text NOT NULL, "conversationId" text NOT NULL, "lastReadPosition" integer NOT NULL DEFAULT 0,
 "lastReadMessageId" text, "updatedAt" timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY ("userId","conversationId")
);
CREATE TABLE IF NOT EXISTS conversation_links (
 id uuid PRIMARY KEY, "sourceConversationId" uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 "linkedConversationId" uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 "anchorPosition" bigint NOT NULL CHECK ("anchorPosition" > 0),
 "firstPosition" bigint NOT NULL CHECK ("firstPosition" > 0),
 "lastPosition" bigint NOT NULL CHECK ("lastPosition" >= "firstPosition"),
 "messageCount" bigint NOT NULL CHECK ("messageCount" > 0),
 CHECK ("sourceConversationId" <> "linkedConversationId")
);
CREATE INDEX IF NOT EXISTS conversation_links_source_idx ON conversation_links ("sourceConversationId","anchorPosition");
