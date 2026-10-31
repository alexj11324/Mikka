-- The existing inbox is the durable wake outbox. Defaults also admit events
-- committed before this migration; no notification content is copied.
ALTER TABLE coordinator_events
  ADD COLUMN IF NOT EXISTS "wakeAttempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "nextWakeAt" timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS "wakeLeaseUntil" timestamptz,
  ADD COLUMN IF NOT EXISTS "wakeLastError" text;
CREATE INDEX IF NOT EXISTS coordinator_events_wake_due_idx
  ON coordinator_events ("nextWakeAt", "userId", "botId")
  WHERE "deliveredAt" IS NULL AND "wakeAttempts" < 8;
