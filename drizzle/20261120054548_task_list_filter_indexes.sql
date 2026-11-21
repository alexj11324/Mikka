-- target: MIKKA_DATABASE_URL
-- The task list's server-side filters (lib/task-list-filters.ts, Capy's task list): assignee, labels and
-- subscriber filters are containment on a task's Mikka metadata, which this GIN index answers; the due date
-- filter reads one text field, which the expression index answers within a workspace. Expression indexes only:
-- nothing is rewritten. SQL-only (expression indexes are not mirrored in lib/db/schema.ts). Safe to run again.
CREATE INDEX IF NOT EXISTS issues_metadata_gin_idx ON issues
  USING gin ((coalesce(content->'attrs'->'mikka', content->'attrs'->'orvilo')) jsonb_path_ops);
CREATE INDEX IF NOT EXISTS issues_due_date_idx ON issues
  ("workspaceId", (coalesce(content->'attrs'->'mikka', content->'attrs'->'orvilo')->>'dueDate'))
  WHERE coalesce(content->'attrs'->'mikka', content->'attrs'->'orvilo')->>'dueDate' IS NOT NULL;
