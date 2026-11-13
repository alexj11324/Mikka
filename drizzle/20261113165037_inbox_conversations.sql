-- Re-run safe. Revert the application first; leave personal dismissals intact.
-- Existing task/suggestion snoozes retain their original constraints and rows.
CREATE TABLE IF NOT EXISTS inbox_conversation_snoozes (
  "workspaceId" uuid NOT NULL, "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "itemType" text NOT NULL CHECK ("itemType"='conversation'), "itemId" uuid NOT NULL,
  "snoozedUntil" timestamptz NOT NULL,
  PRIMARY KEY ("workspaceId","userId","itemType","itemId")
);
CREATE INDEX IF NOT EXISTS inbox_conversation_snoozes_due ON inbox_conversation_snoozes ("snoozedUntil");

CREATE TABLE IF NOT EXISTS inbox_dismissals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspaceId" uuid NOT NULL, "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "itemType" text NOT NULL CHECK ("itemType" IN ('task','conversation')), "itemId" uuid NOT NULL,
  "runId" uuid, reason text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT ("workspaceId","userId","itemType","itemId","runId",reason)
);
