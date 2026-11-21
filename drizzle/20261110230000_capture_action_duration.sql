ALTER TABLE run_capture_steps ADD COLUMN IF NOT EXISTS "durationMs" integer;
ALTER TABLE run_capture_steps ADD CONSTRAINT run_capture_steps_duration_check
  CHECK ("durationMs" IS NULL OR (source = 'action' AND "durationMs" >= 0 AND "durationMs" <= "atMs" AND "durationMs" <= 3600000));
