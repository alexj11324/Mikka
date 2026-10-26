-- Optional native Coordinator transport. No existing user changes runtime.
CREATE TABLE IF NOT EXISTS coordinator_runtime_settings (
  "userId" text PRIMARY KEY,
  runtime jsonb NOT NULL,
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS native_coordinator_turns (
  id uuid PRIMARY KEY,
  "userId" text NOT NULL,
  "deviceId" uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  holder text NOT NULL,
  round integer NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','closed')),
  reply text,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("userId", holder, round)
);
CREATE INDEX IF NOT EXISTS native_coordinator_pending_idx ON native_coordinator_turns("deviceId",status,"createdAt");
CREATE TABLE IF NOT EXISTS native_coordinator_tools (
  "turnId" uuid NOT NULL REFERENCES native_coordinator_turns(id) ON DELETE CASCADE,
  "callId" text NOT NULL,
  name text NOT NULL,
  input jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done')),
  output jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("turnId","callId")
);
