-- Inbox history begins with this migration; historical actions are not backfilled.
CREATE TABLE inbox_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "itemType" text NOT NULL CHECK ("itemType" IN ('task','suggestion')),
  "itemId" uuid NOT NULL,
  "issueId" uuid, "runId" uuid,
  "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "actorId" text NOT NULL,
  action text NOT NULL CHECK (action IN ('answered','approved','merged','accepted','rejected')),
  "sourceKey" text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inbox_history_page ON inbox_history ("createdAt" DESC,id DESC);
CREATE INDEX inbox_history_issue ON inbox_history ("issueId");
CREATE TABLE inbox_metadata (id boolean PRIMARY KEY DEFAULT true CHECK(id), "historySince" timestamptz NOT NULL DEFAULT now());
INSERT INTO inbox_metadata DEFAULT VALUES;
CREATE TABLE inbox_snoozes (
  "workspaceId" uuid NOT NULL, "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "itemType" text NOT NULL CHECK ("itemType" IN ('task','suggestion')), "itemId" uuid NOT NULL,
  "snoozedUntil" timestamptz NOT NULL,
  PRIMARY KEY ("workspaceId","userId","itemType","itemId")
);
CREATE INDEX inbox_snoozes_due ON inbox_snoozes ("snoozedUntil");
ALTER TABLE suggestions ADD COLUMN "rejectedAt" timestamptz, ADD COLUMN "rejectedBy" text;

-- Capture only committed source receipts, including writes outside the inbox API.
CREATE FUNCTION inbox_capture_completion() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item uuid; issue uuid; owner_id text; actor_id text; verb text; key text; kind text := 'task';
BEGIN
  IF TG_TABLE_NAME='run_messages' THEN
    IF NEW.origin <> 'owner' THEN RETURN NEW; END IF;
    SELECT r.id,r."issueId",r."userId" INTO item,issue,owner_id FROM agent_runs r
      WHERE r.id=NEW."runId" AND r."userId"=NEW."userId"
        AND (r.status='waiting_input' OR r.outcome='needs_input');
    IF item IS NULL THEN
      SELECT prior.id,prior."issueId",prior."userId" INTO item,issue,owner_id FROM agent_runs current
        JOIN agent_runs prior ON prior.id=coalesce(current."continuesRunId",current."retryOf") AND prior."userId"=current."userId"
        WHERE current.id=NEW."runId" AND current."userId"=NEW."userId" AND prior.outcome='needs_input';
    END IF;
    actor_id:=NEW."userId"; verb:='answered'; key:='message:'||NEW.id;
  ELSIF TG_TABLE_NAME='factory_questions' THEN
    IF NEW."answerSource" NOT IN ('human','human_event') OR NEW."answerId" IS NULL OR OLD."answerId" IS NOT NULL THEN RETURN NEW; END IF;
    item:=NEW."originRunId"; issue:=NEW."issueId"; owner_id:=NEW."userId"; actor_id:=NEW."userId"; verb:='answered'; key:='message:'||NEW."answerId";
  ELSIF TG_TABLE_NAME='factory_approvals' THEN
    SELECT (SELECT a."runId" FROM factory_attempts a WHERE a.id=t."attemptId"),t."issueId",t."userId"
      INTO item,issue,owner_id FROM factory_tasks t WHERE t.id=NEW."taskId";
    actor_id:=NEW."userId"; verb:='approved'; key:='approval:'||NEW.id;
  ELSIF TG_TABLE_NAME='factory_merges' THEN
    IF NEW.status<>'merged' OR NEW.source<>'mikka' THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND OLD.status='merged' THEN RETURN NEW; END IF;
    SELECT (SELECT a."runId" FROM factory_attempts a WHERE a.id=t."attemptId"),t."issueId",t."userId"
      INTO item,issue,owner_id FROM factory_tasks t WHERE t.id=NEW."taskId";
    actor_id:=NEW."userId"; verb:='merged'; key:='merge:'||NEW.id;
  END IF;
  IF issue IS NOT NULL THEN
    INSERT INTO inbox_history ("itemType","itemId","issueId","runId","ownerId","actorId",action,"sourceKey")
      VALUES(kind,issue,issue,item,owner_id,actor_id,verb,key) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inbox_message AFTER INSERT ON run_messages FOR EACH ROW EXECUTE FUNCTION inbox_capture_completion();
CREATE TRIGGER inbox_question AFTER UPDATE OF "answerId" ON factory_questions FOR EACH ROW EXECUTE FUNCTION inbox_capture_completion();
CREATE TRIGGER inbox_approval AFTER INSERT ON factory_approvals FOR EACH ROW EXECUTE FUNCTION inbox_capture_completion();
CREATE TRIGGER inbox_merge AFTER INSERT OR UPDATE OF status ON factory_merges FOR EACH ROW EXECUTE FUNCTION inbox_capture_completion();

CREATE FUNCTION inbox_capture_suggestion() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."dismissedAt" IS NULL AND NEW."dismissedAt" IS NOT NULL AND NEW."rejectedAt" IS NULL THEN
    INSERT INTO inbox_history("itemType","itemId","ownerId","actorId",action,"sourceKey")
      VALUES('suggestion',NEW.id,NEW."userId",NEW."userId",'accepted','suggestion:'||NEW.id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inbox_suggestion AFTER UPDATE OF "dismissedAt" ON suggestions FOR EACH ROW EXECUTE FUNCTION inbox_capture_suggestion();
