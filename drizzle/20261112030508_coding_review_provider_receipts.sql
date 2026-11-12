ALTER TABLE coding_review_sessions
  ADD COLUMN provider text NOT NULL DEFAULT 'e2b',
  ADD COLUMN "repositoryKey" text,
  ADD COLUMN "reviewOperationId" uuid,
  ADD CONSTRAINT coding_review_session_placement CHECK (
    (provider='e2b' AND "repositoryKey" IS NULL AND "reviewOperationId" IS NULL)
    OR (provider='cloudflare' AND "repositoryKey" IS NOT NULL AND "reviewOperationId" IS NOT NULL
      AND "repositoryKey" ~ '^v2/github[.]com/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$'));
