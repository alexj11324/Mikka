-- target: MIKKA_DATABASE_URL
-- Product-owned immutable inputs for isolated native Eve evaluation sessions.
-- No model credentials, tool effects, chat history or second turn queue.
CREATE TABLE IF NOT EXISTS eve_evaluations (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  evaluation_id uuid NOT NULL REFERENCES agent_kit_evaluations(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES agent_kit_versions(id) ON DELETE CASCADE,
  session_id text UNIQUE,
  plan jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eve_evaluations_owner ON eve_evaluations(owner_id,bot_id,evaluation_id);
