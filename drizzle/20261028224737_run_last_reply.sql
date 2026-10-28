-- The opening of a run's last reply for the right column's thread rows, when it
-- was written, and where the run was dispatched from ('mcp' for an MCP client;
-- null for the app). Replaying this migration leaves existing data intact.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "lastReply" text;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "lastReplyAt" timestamptz;
-- The text part lastReply comes from, so a batch knows to append or replace.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "lastReplyPart" text;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS source text;
-- listThreads asks whether a retry of each run exists.
CREATE INDEX IF NOT EXISTS agent_runs_retry_of_idx ON agent_runs ("retryOf") WHERE "retryOf" IS NOT NULL;
