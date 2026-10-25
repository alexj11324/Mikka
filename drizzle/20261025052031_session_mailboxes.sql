begin;
set local lock_timeout = '5s';
-- Extend Mikka's existing envelopes; no second message bus.
CREATE SEQUENCE IF NOT EXISTS mikka_mailbox_sequence;
CREATE TABLE IF NOT EXISTS session_mailboxes (
  id uuid PRIMARY KEY,
  "userId" text NOT NULL,
  "workspaceId" text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('run', 'coordinator', 'bot')),
  "sessionKey" text NOT NULL,
  harness text,
  "latestRunId" uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  "wakeBudget" integer NOT NULL DEFAULT 0 CHECK ("wakeBudget" BETWEEN 0 AND 10),
  disabled boolean NOT NULL DEFAULT false,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("userId", "workspaceId", kind, "sessionKey")
);
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "mailboxId" uuid REFERENCES session_mailboxes(id);
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "continuesRunId" uuid REFERENCES agent_runs(id);
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "resumeSessionId" text;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "followUp" text;
ALTER TABLE run_messages ALTER COLUMN "runId" DROP NOT NULL;
ALTER TABLE run_messages ADD COLUMN IF NOT EXISTS "mailboxId" uuid REFERENCES session_mailboxes(id);
ALTER TABLE run_messages ADD COLUMN IF NOT EXISTS "senderMailboxId" uuid REFERENCES session_mailboxes(id);
ALTER TABLE run_messages ADD COLUMN IF NOT EXISTS "replyTo" uuid REFERENCES run_messages(id);
ALTER TABLE run_messages ADD COLUMN IF NOT EXISTS "dedupeKey" uuid;
ALTER TABLE run_messages ADD COLUMN IF NOT EXISTS "acknowledgedAt" timestamptz;
ALTER TABLE run_messages ADD COLUMN IF NOT EXISTS "failure" text;
ALTER TABLE run_messages ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'owner' CHECK (origin IN ('owner', 'peer'));
ALTER TABLE run_messages ADD COLUMN IF NOT EXISTS "sequence" bigint NOT NULL DEFAULT nextval('mikka_mailbox_sequence');
CREATE UNIQUE INDEX IF NOT EXISTS run_messages_mailbox_dedupe ON run_messages ("senderMailboxId", "dedupeKey") WHERE "dedupeKey" IS NOT NULL;
CREATE INDEX IF NOT EXISTS run_messages_mailbox_sequence ON run_messages ("mailboxId", sequence);
ALTER TABLE coordinator_events ADD COLUMN IF NOT EXISTS "sequence" bigint NOT NULL DEFAULT nextval('mikka_mailbox_sequence');

-- Existing conversations remain addressable after upgrade, including terminal runs.
-- WORKSPACE_ID is the current server-defined single device workspace; request
-- database scopes continue to isolate tenants. Do not accept a client workspace.
INSERT INTO session_mailboxes (id,"userId","workspaceId",kind,"sessionKey","latestRunId")
SELECT gen_random_uuid(),r."userId",'00000000-0000-4000-8000-000000000001','run',r.id::text,r.id
FROM agent_runs r WHERE r."mailboxId" IS NULL
ON CONFLICT ("userId","workspaceId",kind,"sessionKey") DO NOTHING;
UPDATE session_mailboxes m SET harness=a.harness FROM agent_runs r JOIN agents a ON a.id=r."agentId"
WHERE m.kind='run' AND m."sessionKey"=r.id::text AND m."userId"=r."userId" AND m.harness IS NULL;
UPDATE agent_runs r SET "mailboxId"=m.id FROM session_mailboxes m
WHERE r."mailboxId" IS NULL AND m.kind='run' AND m."sessionKey"=r.id::text
AND m."userId"=r."userId" AND m."workspaceId"='00000000-0000-4000-8000-000000000001';
INSERT INTO session_mailboxes (id,"userId","workspaceId",kind,"sessionKey")
SELECT gen_random_uuid(),"userId",'00000000-0000-4000-8000-000000000001','bot',id::text FROM agent_sessions
ON CONFLICT ("userId","workspaceId",kind,"sessionKey") DO NOTHING;
INSERT INTO session_mailboxes (id,"userId","workspaceId",kind,"sessionKey")
SELECT gen_random_uuid(),u."userId",'00000000-0000-4000-8000-000000000001','coordinator','coordinator'
FROM (SELECT "userId" FROM coordinator_sessions UNION SELECT "userId" FROM agent_runs UNION SELECT "userId" FROM agent_sessions) u
ON CONFLICT ("userId","workspaceId",kind,"sessionKey") DO NOTHING;

commit;
