-- target: MIKKA_DATABASE_URL
-- eve owns the session stream and runtime state. These rows are ownership
-- references and compatibility projection receipts, never another runtime.
CREATE TABLE IF NOT EXISTS eve_sessions (
  session_id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  surface text NOT NULL CHECK (surface IN ('web','slack')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS eve_sessions_bot ON eve_sessions(owner_id,bot_id,created_at DESC);
CREATE TABLE IF NOT EXISTS eve_projection_receipts (
  session_id text NOT NULL REFERENCES eve_sessions(session_id) ON DELETE CASCADE,
  event_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id,event_key)
);
CREATE TABLE IF NOT EXISTS eve_turn_sources (
  session_id text NOT NULL REFERENCES eve_sessions(session_id) ON DELETE CASCADE,
  turn_id text NOT NULL,
  source_event_id uuid NOT NULL REFERENCES coordinator_events(id) ON DELETE CASCADE,
  PRIMARY KEY(session_id,turn_id)
);
