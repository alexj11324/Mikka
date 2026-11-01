-- target: MIKKA_DATABASE_URL
-- A person's own settings for one chat (decision 2026-11-01-0050-mobile-chat-settings):
-- 置顶 puts it in 对话's pinned row, 通知 off stops its pushes. `chatKey` is
-- a bot's id, or 'coordinator'. Only rows someone changed exist.
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS chat_preferences (
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "chatKey" text NOT NULL CHECK (char_length("chatKey") BETWEEN 1 AND 64),
  pinned boolean NOT NULL DEFAULT false,
  muted boolean NOT NULL DEFAULT false,
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", "chatKey")
);
