-- Expand #499: retain JSON metadata for existing readers and writers.
BEGIN;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "lastIssueNumber" bigint NOT NULL DEFAULT 0;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS number bigint GENERATED ALWAYS AS (
  CASE WHEN content #>> '{attrs,mikka,number}' ~ '^[1-9][0-9]*$'
    THEN (content #>> '{attrs,mikka,number}')::bigint END
) STORED;

-- Synchronize existing writers during rollout. New allocators update the same
-- owner row before inserting an issue, so both versions serialize on that row.
CREATE OR REPLACE FUNCTION sync_issue_number_counter() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.number IS NOT NULL THEN
    IF TG_OP='INSERT' THEN
      UPDATE "user" SET "lastIssueNumber"=NEW.number
        WHERE id=NEW."userId" AND "lastIssueNumber"<NEW.number;
    ELSIF NEW.number IS DISTINCT FROM OLD.number OR NEW."userId" IS DISTINCT FROM OLD."userId" THEN
      UPDATE "user" SET "lastIssueNumber"=NEW.number
        WHERE id=NEW."userId" AND "lastIssueNumber"<NEW.number;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS sync_issue_number_counter ON issues;
CREATE TRIGGER sync_issue_number_counter AFTER INSERT OR UPDATE OF content,"userId" ON issues
  FOR EACH ROW EXECUTE FUNCTION sync_issue_number_counter();

-- Assign only unnumbered historical issues; preserve every existing number.
WITH maxima AS (
  SELECT "userId",coalesce(max(number),0) AS n FROM issues GROUP BY "userId"
), missing AS (
  SELECT i.id,m.n+row_number() OVER (PARTITION BY i."userId" ORDER BY i."createdAt",i.id) AS n
  FROM issues i JOIN maxima m ON m."userId"=i."userId" WHERE i.number IS NULL
)
UPDATE issues i SET content=jsonb_set(i.content,'{attrs}',
  coalesce(i.content->'attrs','{}'::jsonb) || jsonb_build_object('mikka',
    coalesce(i.content #> '{attrs,mikka}','{}'::jsonb) || jsonb_build_object('number',m.n)),true)
FROM missing m WHERE i.id=m.id;

UPDATE "user" u SET "lastIssueNumber"=greatest(u."lastIssueNumber",m.n)
FROM (SELECT "userId",max(number) AS n FROM issues GROUP BY "userId") m
WHERE u.id=m."userId";
COMMIT;
