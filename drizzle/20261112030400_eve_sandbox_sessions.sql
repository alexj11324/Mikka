-- Portable JustBash scratch files; no local template path or paid sandbox service.
CREATE TABLE IF NOT EXISTS eve_sandbox_sessions (
  session_id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  surface text NOT NULL CHECK (surface IN ('web','slack')),
  snapshot jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS eve_sandbox_sessions_owner_idx ON eve_sandbox_sessions(owner_id,bot_id);
