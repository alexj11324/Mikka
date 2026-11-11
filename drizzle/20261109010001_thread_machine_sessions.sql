-- The mutable thread_machines row is current custody, not VM history. Keep
-- confirmed running intervals across pauses, replacement and attempt handoff.
CREATE TABLE IF NOT EXISTS thread_machine_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "runId" uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "workspaceId" uuid NOT NULL,
  "botId" uuid,
  "sandboxId" text NOT NULL,
  "startedAt" timestamptz NOT NULL,
  "endedAt" timestamptz,
  reason text CHECK (reason IN ('paused','retired','provider_missing','transferred','replaced','scope_changed')),
  source text NOT NULL CHECK (source IN ('running_since','observed','running_since_backfill')),
  CHECK ("endedAt" IS NULL OR "endedAt">="startedAt"),
  CHECK (("endedAt" IS NULL)=(reason IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS thread_machine_sessions_open_run
  ON thread_machine_sessions("runId") WHERE "endedAt" IS NULL;
CREATE INDEX IF NOT EXISTS thread_machine_sessions_scope_run
  ON thread_machine_sessions("ownerId","workspaceId","runId","startedAt",id);

-- runningSince is the only retained start of the current running interval.
-- createdAt is machine-row creation, and endedAt may be only a stop request;
-- neither is evidence for a historical VM interval.
INSERT INTO thread_machine_sessions("runId","ownerId","workspaceId","botId","sandboxId","startedAt",source)
  SELECT "runId","ownerId","workspaceId","botId","sandboxId","runningSince",'running_since_backfill'
  FROM thread_machines WHERE "sandboxId" IS NOT NULL AND "runningSince" IS NOT NULL
  ON CONFLICT ("runId") WHERE "endedAt" IS NULL DO NOTHING;

CREATE OR REPLACE FUNCTION record_thread_machine_session() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  observed_at timestamptz := clock_timestamp();
  closed_at timestamptz;
  close_reason text;
  changed_scope boolean := false;
  new_binding boolean;
BEGIN
  IF TG_OP='UPDATE' THEN
    changed_scope := NEW."ownerId" IS DISTINCT FROM OLD."ownerId"
      OR NEW."workspaceId" IS DISTINCT FROM OLD."workspaceId"
      OR NEW."botId" IS DISTINCT FROM OLD."botId";
    IF changed_scope THEN close_reason := 'scope_changed';
    ELSIF NEW."sandboxId" IS DISTINCT FROM OLD."sandboxId" THEN
      close_reason := CASE
        WHEN NEW.lifecycle->>'phase'='transferred' THEN 'transferred'
        WHEN NEW.lifecycle->>'phase'='retired' THEN 'retired'
        WHEN NEW."sandboxId" IS NULL AND NEW.state='starting' THEN 'provider_missing'
        ELSE 'replaced' END;
    ELSIF NEW.state='paused' AND NEW."runningSince" IS NULL
      AND (OLD.state<>'paused' OR OLD."runningSince" IS NOT NULL)
      THEN close_reason := 'paused';
    ELSIF NEW.state='error' AND NEW."runningSince" IS NULL AND (OLD."runningSince" IS NOT NULL
      OR (NEW.lifecycle->>'providerMissingReceipt' IS NOT NULL
        AND NEW.lifecycle->>'providerMissingReceipt' IS DISTINCT FROM OLD.lifecycle->>'providerMissingReceipt'))
      THEN close_reason := 'provider_missing';
    END IF;
    IF close_reason IS NOT NULL THEN
      -- A running custody transfer shares one server timestamp with the next
      -- run. Keep its microseconds; transaction_timestamp() can predate it.
      closed_at := CASE WHEN close_reason='transferred'
        THEN COALESCE((NEW.lifecycle->>'transferredAt')::timestamptz,observed_at) ELSE observed_at END;
      UPDATE thread_machine_sessions SET "endedAt"=GREATEST("startedAt",closed_at),reason=close_reason
        WHERE "runId"=OLD."runId" AND "ownerId"=OLD."ownerId" AND "workspaceId"=OLD."workspaceId"
          AND "sandboxId"=OLD."sandboxId" AND "endedAt" IS NULL;
    END IF;
    new_binding := NEW."sandboxId" IS DISTINCT FROM OLD."sandboxId" OR changed_scope
      OR (NEW."runningSince" IS NOT NULL AND OLD."runningSince" IS NULL)
      OR (NEW.state='running' AND OLD.state='paused');
  ELSE new_binding := true;
  END IF;

  -- A late successful create can be recorded after cancellation, with state
  -- ended and no runningSince. Its observed binding proves that a VM exists;
  -- its actual earlier allocation time is unknown. recordThreadSandbox also
  -- writes a confirmed resume's runningSince before registration changes the
  -- paused custody state. That timestamp already proves a running interval.
  IF new_binding AND NEW."sandboxId" IS NOT NULL
    AND (NEW.state<>'paused' OR NEW."runningSince" IS NOT NULL) THEN
    INSERT INTO thread_machine_sessions("runId","ownerId","workspaceId","botId","sandboxId","startedAt",source)
      VALUES (NEW."runId",NEW."ownerId",NEW."workspaceId",NEW."botId",NEW."sandboxId",
        CASE WHEN changed_scope THEN observed_at ELSE COALESCE(NEW."runningSince",observed_at) END,
        CASE WHEN NEW."runningSince" IS NOT NULL AND NOT changed_scope THEN 'running_since' ELSE 'observed' END)
      ON CONFLICT ("runId") WHERE "endedAt" IS NULL DO NOTHING;
  END IF;
  -- state=ended with the same sandbox is a retirement request, not provider
  -- acknowledgement. Keep its interval open until the confirmed clear above.
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS thread_machine_session_history ON thread_machines;
CREATE TRIGGER thread_machine_session_history
  AFTER INSERT OR UPDATE OF "sandboxId","runningSince",state,"ownerId","workspaceId","botId",lifecycle
  ON thread_machines FOR EACH ROW EXECUTE FUNCTION record_thread_machine_session();
