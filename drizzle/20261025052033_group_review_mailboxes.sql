-- target: MIKKA_DATABASE_URL
-- Conversation-only runtime capability; never a private/repository mailbox.
ALTER TABLE session_mailboxes DROP CONSTRAINT IF EXISTS session_mailboxes_kind_check;
ALTER TABLE session_mailboxes ADD CONSTRAINT session_mailboxes_kind_check CHECK (kind IN ('run','coordinator','bot','group'));
ALTER TABLE conversation_work ADD COLUMN IF NOT EXISTS "claimEpoch" integer NOT NULL DEFAULT 0;
-- Existing group_review attempts may have been backfilled by the generic
-- mailbox migration. Preserve their address but remove private discovery/wakes.
UPDATE session_mailboxes m SET kind='group',"wakeBudget"=0
FROM agent_runs r WHERE r."mailboxId"=m.id AND r.kind='group_review';
UPDATE session_mailboxes m SET "workspaceId"=c."workspaceId"::text,"sessionKey"=w.id::text
FROM agent_runs r JOIN conversation_work w ON w."runId"=r.id JOIN conversations c ON c.id=w."conversationId"
WHERE r."mailboxId"=m.id AND r.kind='group_review';
UPDATE session_mailboxes m SET disabled=true FROM agent_runs r
WHERE r."mailboxId"=m.id AND r.kind='group_review'
AND NOT EXISTS (SELECT 1 FROM conversation_work w WHERE w."runId"=r.id);
UPDATE run_messages e SET "mailboxId"=r."mailboxId" FROM agent_runs r
WHERE e."runId"=r.id AND r.kind='group_review' AND e."mailboxId" IS NULL;
