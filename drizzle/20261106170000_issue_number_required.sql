-- Every task has its number from the moment it exists (Alex, 2026-11-06).
-- One allocator in the database: an insert without a number gets the owner's
-- next one, and an edit can never drop it. Then the column is required.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION assign_issue_number() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  next_number bigint;
BEGIN
  IF NEW.content #>> '{attrs,mikka,number}' ~ '^[1-9][0-9]*$' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.number IS NOT NULL AND NEW."userId" = OLD."userId" THEN
    next_number := OLD.number;
  ELSE
    -- Same counter and row lock as lib/issue-numbering.ts.
    UPDATE "user" SET "lastIssueNumber" = "lastIssueNumber" + 1
      WHERE id = NEW."userId" RETURNING "lastIssueNumber" INTO next_number;
    IF next_number IS NULL THEN
      -- An owner with no account row (imported or fixture data): serialize on the owner.
      PERFORM pg_advisory_xact_lock(hashtextextended('issue-number:' || NEW."userId", 0));
      SELECT coalesce(max(number), 0) + 1 INTO next_number FROM issues WHERE "userId" = NEW."userId";
    END IF;
  END IF;
  NEW.content := jsonb_set(coalesce(NEW.content, '{}'::jsonb), '{attrs}',
    coalesce(NEW.content -> 'attrs', '{}'::jsonb) || jsonb_build_object('mikka',
      coalesce(NEW.content #> '{attrs,mikka}', '{}'::jsonb) || jsonb_build_object('number', next_number)), true);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS assign_issue_number ON issues;
CREATE TRIGGER assign_issue_number BEFORE INSERT OR UPDATE OF content, "userId" ON issues
  FOR EACH ROW EXECUTE FUNCTION assign_issue_number();

-- Number every unnumbered task after its owner's highest, in creation order.
WITH maxima AS (
  SELECT "userId", coalesce(max(number), 0) AS n FROM issues GROUP BY "userId"
), missing AS (
  SELECT i.id, m.n + row_number() OVER (PARTITION BY i."userId" ORDER BY i."createdAt", i.id) AS n
  FROM issues i JOIN maxima m ON m."userId" = i."userId" WHERE i.number IS NULL
)
UPDATE issues i SET content = jsonb_set(i.content, '{attrs}',
  coalesce(i.content -> 'attrs', '{}'::jsonb) || jsonb_build_object('mikka',
    coalesce(i.content #> '{attrs,mikka}', '{}'::jsonb) || jsonb_build_object('number', m.n)), true)
FROM missing m WHERE i.id = m.id;

ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_number_required;
ALTER TABLE issues ADD CONSTRAINT issues_number_required CHECK (number IS NOT NULL);
COMMIT;
