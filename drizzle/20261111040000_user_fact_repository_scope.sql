-- ALE-68: a fact about work belongs to the repository it is true of.
--
-- R-73 stores what Mikka learnt about one person (user_facts). Until now the
-- only key was ("userId", kind, "subjectKey"), so one subject had exactly one
-- answer for that person in every context: "uses pnpm" was either true for
-- every repository they work in or could not be remembered at all. Mikka
-- already scopes per-repository settings and secrets the same way
-- (repository_settings."remoteKey", workspace_secrets scopeType='repository'),
-- and a GitHub event names its repository exactly, so the fact carries it too.
--
-- repository = null keeps today's meaning: a fact about the person themselves
-- (an interest, a subscription, a routine), true wherever they are. A fact with
-- a repository is true only of work in that repository, and is injected only
-- into a chat whose workspace works in it (lib/profile/prompt.ts).
--
-- The column is folded for comparison (lower case, trimmed) when written
-- (lib/profile/store.ts recordFacts), so the key is stable across the ways a
-- remote is spelled. NULLS NOT DISTINCT makes the account-level rows keep one
-- row per subject: a plain unique index would let every NULL be a new row and
-- repeats would stop merging. Additive and idempotent.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE user_facts ADD COLUMN IF NOT EXISTS repository text;

ALTER TABLE user_facts DROP CONSTRAINT IF EXISTS user_facts_subject_key;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_facts_repository_subject_key' AND conrelid = 'user_facts'::regclass) THEN
    ALTER TABLE user_facts ADD CONSTRAINT user_facts_repository_subject_key
      UNIQUE NULLS NOT DISTINCT ("userId", repository, kind, "subjectKey");
  END IF;
END $$;

-- 记忆 and the agent prompt both read one person's active facts and filter by
-- repository; this keeps that read on an index instead of the whole table.
CREATE INDEX IF NOT EXISTS user_facts_repository_idx ON user_facts ("userId", repository, state);

COMMIT;
