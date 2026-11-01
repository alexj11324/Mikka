-- Push is authorized by the Mikka GitHub App's installation (decision
-- 2026-11-01-1215-push-by-github-app): when a live check last found that the
-- App's installation on the repository grants contents:write and the person's
-- GitHub account may write to it, admission records the time here; a refused
-- check clears it. Existing rows never recorded it, so they start null and are
-- verified again on the next dispatch. Additive and rerunnable.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE github_repository_installations ADD COLUMN IF NOT EXISTS "pushGrantedAt" timestamptz;
COMMIT;
