ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS "conversationArchivedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "conversationPinnedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "conversationRestoredAt" timestamptz;
