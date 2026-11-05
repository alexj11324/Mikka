-- target: MIKKA_DATABASE_URL
-- The home chat list's own state per person and chat (#1408 Phase 2b): a hidden chat leaves the list for 隐藏的聊天,
-- 标为未读 marks a chat until it is opened, and a drag sets the order of the pins and of the list. `chatKey` is a
-- bot's id or, for a group chat, its conversation id. Columns only: no row is rewritten, so the change is instant.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE chat_preferences ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
ALTER TABLE chat_preferences ADD COLUMN IF NOT EXISTS "markedUnread" boolean NOT NULL DEFAULT false;
ALTER TABLE chat_preferences ADD COLUMN IF NOT EXISTS "pinOrder" integer;
ALTER TABLE chat_preferences ADD COLUMN IF NOT EXISTS "listOrder" integer;
COMMIT;
