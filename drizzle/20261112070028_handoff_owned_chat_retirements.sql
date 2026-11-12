BEGIN;
SET LOCAL lock_timeout = '5s';

-- The APP and Workspace may share one physical database. The Workspace write
-- fence then also guards this internal queue. Preserve it for every new write.
-- A nested attachment DELETE can omit a duplicate retirement only if the
-- frozen owner and that exact key are already covered by the job's receipt.
CREATE OR REPLACE FUNCTION mikka_chat_retirement_already_captured() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 AND NEW."userId" IS NOT NULL AND NEW."taskId" IS NULL AND EXISTS (
    SELECT 1
    FROM account_deletion_guards g
    JOIN account_deletion_jobs j ON j.id = g."jobId" AND j."subjectUserId" = g."subjectId"
    WHERE g."subjectId" = NEW."userId" AND j.stage = 'main_deleted'
      AND j."pendingObjects" ? NEW."storageKey"
      AND j."storageNotBefore" IS NOT NULL
      AND NEW."notBefore" <= greatest(j."storageNotBefore", transaction_timestamp())
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;

-- PostgreSQL evaluates BEFORE triggers of the same kind in name order.
CREATE TRIGGER account_deletion_captured_chat_retirement
BEFORE INSERT ON chat_attachment_retirements
FOR EACH ROW EXECUTE FUNCTION mikka_chat_retirement_already_captured();
COMMIT;
