-- A null branch means the remote's default branch, resolved after fetch.
-- Existing branch values and repository records remain unchanged.
ALTER TABLE device_repos ALTER COLUMN "baseBranch" DROP NOT NULL;
ALTER TABLE agent_runs ALTER COLUMN "baseBranch" DROP NOT NULL;

-- No approvals or machine-specific settings are copied implicitly.
CREATE TABLE IF NOT EXISTS repository_settings (
  "userId" text NOT NULL,
  "remoteKey" text NOT NULL,
  "verifyCommand" text,
  setup jsonb,
  "networkAllow" jsonb,
  push jsonb,
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", "remoteKey")
);
