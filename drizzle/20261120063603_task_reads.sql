-- target: MIKKA_DATABASE_URL
-- Capy's "Mark as unread" on a task (S1-C): a person flags a task unread for themselves; opening the task clears the
-- flag. One row per person and task, written only by app/actions/task-list.ts. A person's rows go with their account, a
-- task's rows with the task; the workspace column lets workspace deletion find them (lib/workspace-rows.ts).
CREATE TABLE IF NOT EXISTS task_reads (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  unread boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, issue_id)
);
CREATE INDEX IF NOT EXISTS task_reads_unread_idx ON task_reads (user_id, workspace_id) WHERE unread;
