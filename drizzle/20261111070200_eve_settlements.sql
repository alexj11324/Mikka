-- target: MIKKA_DATABASE_URL
-- Product publication receipts survive an accepted eve hook RPC whose response
-- is lost. They do not own agent turns, queues or model history.
CREATE TABLE IF NOT EXISTS eve_turn_settlements (
  session_id text NOT NULL REFERENCES eve_sessions(session_id) ON DELETE CASCADE,
  turn_id text NOT NULL,
  request_digest text NOT NULL,
  occurrence jsonb,
  completed_at timestamptz,
  PRIMARY KEY(session_id,turn_id)
);
