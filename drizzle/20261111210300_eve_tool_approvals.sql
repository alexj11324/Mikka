-- Native Eve interactions own the approval UI; this is the product effect receipt.
CREATE TABLE IF NOT EXISTS eve_tool_approvals (
  call_key text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  call_digest text NOT NULL,
  plan_digest text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('allow','ask','deny')),
  status text NOT NULL CHECK (status IN ('prepared','executing','done')),
  output jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS eve_tool_approvals_owner_idx ON eve_tool_approvals(owner_id,bot_id);
