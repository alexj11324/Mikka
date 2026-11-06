-- target: DATABASE_URL
-- A workspace task is named by its team: the team key and the next number in
-- that team (AL-12), like Linear. The database assigns it when the task joins
-- a team and again when it moves to another; it is never empty.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE mikka_teams ADD COLUMN IF NOT EXISTS "lastIssueNumber" bigint NOT NULL DEFAULT 0;
ALTER TABLE mikka_team_issues ADD COLUMN IF NOT EXISTS number bigint;

CREATE OR REPLACE FUNCTION assign_team_issue_number() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  next_number bigint;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."teamId" = OLD."teamId" THEN
    NEW.number := coalesce(NEW.number, OLD.number);
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.number IS NOT NULL THEN
    UPDATE mikka_teams SET "lastIssueNumber" = greatest("lastIssueNumber", NEW.number) WHERE id = NEW."teamId";
    RETURN NEW;
  END IF;
  UPDATE mikka_teams SET "lastIssueNumber" = "lastIssueNumber" + 1
    WHERE id = NEW."teamId" RETURNING "lastIssueNumber" INTO next_number;
  IF next_number IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('team-issue-number:' || NEW."teamId", 0));
    SELECT coalesce(max(number), 0) + 1 INTO next_number FROM mikka_team_issues WHERE "teamId" = NEW."teamId";
  END IF;
  NEW.number := next_number;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS assign_team_issue_number ON mikka_team_issues;
CREATE TRIGGER assign_team_issue_number BEFORE INSERT OR UPDATE ON mikka_team_issues
  FOR EACH ROW EXECUTE FUNCTION assign_team_issue_number();

WITH numbered AS (
  SELECT "issueId", row_number() OVER (PARTITION BY "teamId" ORDER BY "createdAt", "issueId") AS n
  FROM mikka_team_issues WHERE number IS NULL
)
UPDATE mikka_team_issues t SET number = n.n FROM numbered n WHERE t."issueId" = n."issueId";
UPDATE mikka_teams m SET "lastIssueNumber" = greatest(m."lastIssueNumber", coalesce((SELECT max(number) FROM mikka_team_issues t WHERE t."teamId" = m.id), 0));

ALTER TABLE mikka_team_issues ALTER COLUMN number SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS mikka_team_issues_team_number_unique ON mikka_team_issues ("teamId", number);
COMMIT;
