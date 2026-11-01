-- target: MIKKA_DATABASE_URL
-- One task, one cloud sandbox (Alex, 2026-11-01: 「任务跟沙箱机器应该是强绑定。不能一个
-- 任务用完之后，另外一个任务接着去用」). A run's machine records its task, so the
-- task's next run resumes that paused sandbox instead of starting a new one,
-- and no other task can be given it.
ALTER TABLE thread_machines ADD COLUMN IF NOT EXISTS "issueId" uuid;
CREATE INDEX IF NOT EXISTS thread_machines_paused_task ON thread_machines ("ownerId", "workspaceId", "issueId") WHERE state = 'paused' AND "issueId" IS NOT NULL;
