-- target: MIKKA_DATABASE_URL
-- Decision 2026-11-17: a Bot names the Agent its tasks run on (Claude Code or
-- Codex). There is no default: existing Bots keep no Agent and their next
-- dispatch asks the person to choose one (botAgentRequired).
SET lock_timeout = '5s';
ALTER TABLE bots ADD COLUMN IF NOT EXISTS agent text;
ALTER TABLE bots DROP CONSTRAINT IF EXISTS bots_agent_check;
ALTER TABLE bots ADD CONSTRAINT bots_agent_check CHECK (agent IS NULL OR agent IN ('claude_code', 'codex'));
