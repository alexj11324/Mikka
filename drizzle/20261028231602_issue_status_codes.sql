-- target: MIKKA_DATABASE_URL
-- Align the database with ISSUE_STATUS_CODES, including Telegram's backlog default.
BEGIN;
ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_status_check;
ALTER TABLE issues ADD CONSTRAINT issues_status_check
  CHECK (status IN ('backlog', 'todo', 'doing', 'review', 'done', 'canceled', 'duplicate'));
COMMIT;
