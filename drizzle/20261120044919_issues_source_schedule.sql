-- target: MIKKA_DATABASE_URL

-- 查看运行 (View runs): a task an automation's run made remembers that automation, so the thread directory can
-- list the threads one automation started (`automation=<id>`). The run's own record (schedule_occurrences.result)
-- names the task it made; the store writes the column when it records a succeeded dispatch, and this backfills
-- the runs recorded before. A deleted automation leaves its tasks without the link. Mirrors lib/db/schema.ts.
-- Safe to run again.
BEGIN;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS source_schedule_id uuid REFERENCES user_schedules(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS issues_source_schedule_idx ON issues (source_schedule_id) WHERE source_schedule_id IS NOT NULL;
-- The first run that made the task wins; a 追加到同一个任务 run names the same task again.
UPDATE issues i SET source_schedule_id = made.schedule_id
FROM (
  SELECT DISTINCT ON ((o.result->>'id')::uuid) (o.result->>'id')::uuid AS issue_id, o.schedule_id
  FROM schedule_occurrences o
  WHERE o.status = 'succeeded' AND o.result ? 'requestedBy'
    AND o.result->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ORDER BY (o.result->>'id')::uuid, o.created_at, o.id
) made
WHERE i.id = made.issue_id AND i.source_schedule_id IS NULL;
COMMIT;
