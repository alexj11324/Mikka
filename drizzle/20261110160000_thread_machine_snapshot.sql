-- target: MIKKA_DATABASE_URL
-- A task's machine can be rebuilt from its own filesystem snapshot when E2B no
-- longer has the paused sandbox. The reference lives on the run's
-- thread_machines row and never crosses a task, owner or workspace. `snapshotId`
-- stays the template/image the sandbox was created from (never a snapshot).
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE thread_machines ADD COLUMN IF NOT EXISTS "filesystemSnapshotId" text;
ALTER TABLE thread_machines ADD COLUMN IF NOT EXISTS "snapshotOperationId" uuid;
ALTER TABLE thread_machines ADD COLUMN IF NOT EXISTS "snapshotTakenAt" timestamptz;
ALTER TABLE thread_machines ADD COLUMN IF NOT EXISTS "snapshotState" text NOT NULL DEFAULT 'none';
ALTER TABLE thread_machines ADD COLUMN IF NOT EXISTS "restoreStartedAt" timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'thread_machines'::regclass AND conname = 'thread_machines_snapshot_state_check') THEN
    ALTER TABLE thread_machines ADD CONSTRAINT thread_machines_snapshot_state_check
      CHECK ("snapshotState" IN ('none','creating','ready','failed','unavailable'));
  END IF;
END
$$;

COMMENT ON COLUMN thread_machines."snapshotId" IS 'Template or image ID used to create this sandbox; never a filesystem snapshot. See filesystemSnapshotId.';
COMMENT ON COLUMN thread_machines."filesystemSnapshotId" IS 'E2B filesystem snapshot of this run''s task machine, usable only for the same task, owner and workspace.';

-- `restore` is a provisioned sandbox being recreated from the task's own
-- snapshot after the provider reported the previous VM missing.
ALTER TABLE thread_machines DROP CONSTRAINT IF EXISTS thread_machines_state_check;
ALTER TABLE thread_machines ADD CONSTRAINT thread_machines_state_check
  CHECK (state IN ('starting','running','paused','restore','ended','error'));

CREATE INDEX IF NOT EXISTS thread_machines_restore_due
  ON thread_machines ("lifecycleAt") WHERE state='restore';

-- A restore clears the gone sandbox, so its session interval closes for the
-- same reason a provider-missing start does. Keep the rest of the trigger.
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
        WHEN NEW."sandboxId" IS NULL AND NEW.state IN ('starting','restore') THEN 'provider_missing'
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

  IF new_binding AND NEW."sandboxId" IS NOT NULL
    AND (NEW.state<>'paused' OR NEW."runningSince" IS NOT NULL) THEN
    INSERT INTO thread_machine_sessions("runId","ownerId","workspaceId","botId","sandboxId","startedAt",source)
      VALUES (NEW."runId",NEW."ownerId",NEW."workspaceId",NEW."botId",NEW."sandboxId",
        CASE WHEN changed_scope THEN observed_at ELSE COALESCE(NEW."runningSince",observed_at) END,
        CASE WHEN NEW."runningSince" IS NOT NULL AND NOT changed_scope THEN 'running_since' ELSE 'observed' END)
      ON CONFLICT ("runId") WHERE "endedAt" IS NULL DO NOTHING;
  END IF;
  RETURN NEW;
END $$;

COMMIT;
