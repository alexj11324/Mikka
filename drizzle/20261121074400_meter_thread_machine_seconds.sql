BEGIN;

ALTER TABLE thread_machine_sessions ADD COLUMN IF NOT EXISTS "durationSeconds" bigint;

CREATE OR REPLACE FUNCTION meter_thread_machine_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."durationSeconds" := floor(EXTRACT(EPOCH FROM NEW."endedAt" - NEW."startedAt"))::bigint;
  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER thread_machine_sessions_meter
  BEFORE INSERT OR UPDATE OF "startedAt","endedAt","durationSeconds" ON thread_machine_sessions
  FOR EACH ROW EXECUTE FUNCTION meter_thread_machine_session();

COMMENT ON COLUMN thread_machine_sessions."durationSeconds" IS
  'Whole elapsed seconds in the confirmed running interval, independent of credit prepay. NULL for open intervals and historical intervals closed before metering.';

COMMIT;
