-- target: MIKKA_DATABASE_URL
-- A person's reaction to a chat message, from the iOS app's long press
-- (decision 2026-11-01-0030-mobile-reactions): one emoji per person per
-- message, in a bot chat (coordinator_messages) or a group chat
-- (conversation_messages). Access is checked against the message on write.
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS message_reactions (
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "messageId" uuid NOT NULL,
  emoji text NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 16),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", "messageId")
);
CREATE INDEX IF NOT EXISTS message_reactions_message_idx ON message_reactions ("messageId");
