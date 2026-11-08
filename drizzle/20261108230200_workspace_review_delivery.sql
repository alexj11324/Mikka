DROP INDEX IF EXISTS coding_workspace_review_batches_semantic;
CREATE UNIQUE INDEX coding_workspace_review_batches_semantic
  ON coding_workspace_review_batches ("boardId","userId",destination,fingerprint) WHERE state<>'rejected';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='coding_workspace_review_batch_accepted'
    AND conrelid='coding_workspace_review_batches'::regclass) THEN
    ALTER TABLE coding_workspace_review_batches ADD CONSTRAINT coding_workspace_review_batch_accepted
      CHECK (state<>'accepted' OR receipt IS NOT NULL);
  END IF;
END $$;
CREATE OR REPLACE FUNCTION mikka_workspace_review_batch_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW."boardId",NEW."snapshotId",NEW."userId",NEW.fingerprint,NEW.destination,NEW.input,NEW."createdAt")
    IS DISTINCT FROM (OLD.id,OLD."boardId",OLD."snapshotId",OLD."userId",OLD.fingerprint,OLD.destination,OLD.input,OLD."createdAt")
    OR (OLD.state IN ('accepted','rejected') AND NEW IS DISTINCT FROM OLD)
    OR (OLD.state='uncertain' AND NEW.state NOT IN ('uncertain','accepted'))
    OR (OLD.state='delivering' AND NEW.state='prepared')
  THEN RAISE EXCEPTION 'workspace_review_batch_immutable' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS coding_workspace_review_batch_immutable ON coding_workspace_review_batches;
CREATE TRIGGER coding_workspace_review_batch_immutable BEFORE UPDATE ON coding_workspace_review_batches
  FOR EACH ROW EXECUTE FUNCTION mikka_workspace_review_batch_immutable();
