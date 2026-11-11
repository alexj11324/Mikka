-- Telegram has no request idempotency key. Record dispatch before provider I/O;
-- a crashed or uncertain dispatch is never automatically posted again.
CREATE TABLE IF NOT EXISTS eve_outcome_deliveries (
  session_id text NOT NULL REFERENCES eve_sessions(session_id) ON DELETE CASCADE,
  turn_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('telegram','phone')),
  target_key text NOT NULL,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  source_event_id uuid NOT NULL REFERENCES coordinator_events(id) ON DELETE CASCADE,
  request_digest text NOT NULL,
  status text NOT NULL CHECK (status IN ('dispatching','completed','unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (session_id,turn_id,kind,target_key,chunk_index)
);
