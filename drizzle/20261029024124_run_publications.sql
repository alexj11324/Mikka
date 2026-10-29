-- Publication receipts and verified App installations contain no credentials.
-- Append-only, replayable on an empty or existing application database.
CREATE TABLE IF NOT EXISTS github_repository_installations (
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "remoteKey" text NOT NULL,
  "githubAccountId" text NOT NULL,
  "installationId" bigint NOT NULL,
  "repositoryId" bigint NOT NULL,
  "verifiedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", "remoteKey")
);

CREATE TABLE IF NOT EXISTS run_publications (
  "runId" uuid PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "issueId" uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  "remoteUrl" text NOT NULL,
  "remoteKey" text NOT NULL,
  identifier text,
  branch text,
  "baseBranch" text,
  "pushApproved" boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'assigned',
  "workflowRunId" text,
  "leaseToken" uuid,
  "leaseExpiresAt" timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  "pullRequest" jsonb,
  "errorCode" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS run_publications_issue_repo_idx ON run_publications ("issueId", "remoteKey");
CREATE INDEX IF NOT EXISTS run_publications_pending_idx ON run_publications (status, "leaseExpiresAt");
