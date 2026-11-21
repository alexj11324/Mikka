-- target: MIKKA_DATABASE_URL

-- The first-run guide resumes on any device: the step it is on and what was
-- done or skipped (decision 2026-11-15-1900, docs/design/onboarding.md). A row in
-- user_onboarding still means the guide is finished; this table only holds an
-- unfinished guide's place.
-- The setup checklist on 新建任务 is hidden per person and workspace once the
-- person dismisses it; its items' state is read from what exists, not stored.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE IF NOT EXISTS user_onboarding_progress (
  "userId" text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  step smallint NOT NULL DEFAULT 0 CHECK (step BETWEEN 0 AND 3),
  status jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS setup_checklist_dismissals (
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "workspaceId" uuid NOT NULL,
  "dismissedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", "workspaceId")
);
COMMIT;
