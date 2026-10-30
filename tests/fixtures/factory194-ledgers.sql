-- #194 consumer ledgers. #192 owns all stage/candidate state.
BEGIN;
CREATE TABLE IF NOT EXISTS factory_evidence_reads (
  id uuid PRIMARY KEY, "taskId" uuid NOT NULL REFERENCES factory_tasks(id) ON DELETE CASCADE,
  "userId" text NOT NULL, "principalId" text NOT NULL, binding jsonb NOT NULL,
  "evidenceDigest" text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS factory_approvals (
  id uuid PRIMARY KEY, "taskId" uuid NOT NULL REFERENCES factory_tasks(id) ON DELETE CASCADE,
  "candidateId" uuid NOT NULL, "attemptId" uuid NOT NULL,
  "userId" text NOT NULL, "principalId" text NOT NULL,
  -- Human identity exists only when the existing policy actually asked.
  "humanSessionId" text, "decisionCredentialId" text, "decisionScope" jsonb, "decisionEvidence" jsonb,
  "eventId" uuid NOT NULL, request jsonb NOT NULL,
  candidate jsonb NOT NULL, action text NOT NULL, target text NOT NULL,
  "evidenceDigest" text, evidence jsonb NOT NULL,
  "approvedRevision" integer NOT NULL, "publishAttemptId" uuid NOT NULL,
  "publishRevision" integer NOT NULL,
  "expiresAt" timestamptz NOT NULL, "revokedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY ("taskId","candidateId") REFERENCES factory_candidates("taskId",id),
  FOREIGN KEY ("taskId","attemptId") REFERENCES factory_attempts("taskId",id),
  UNIQUE ("taskId","eventId"),
  CHECK (action IN ('deploy_preview','deploy_production','merge'))
);
CREATE TABLE IF NOT EXISTS factory_publications (
  id uuid PRIMARY KEY, "approvalId" uuid NOT NULL UNIQUE REFERENCES factory_approvals(id),
  "taskId" uuid NOT NULL REFERENCES factory_tasks(id) ON DELETE CASCADE,
  "candidateId" uuid NOT NULL, action text NOT NULL, target text NOT NULL,
  "eventId" uuid NOT NULL, request jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved','succeeded','uncertain','failed')),
  receipt jsonb, result jsonb, "createdAt" timestamptz NOT NULL DEFAULT now(), "finishedAt" timestamptz,
  -- Fresh approvals cannot repeat a possibly performed logical action.
  UNIQUE ("taskId","candidateId",action,target), UNIQUE ("taskId","eventId")
);
-- One verified credential creates one grant. Replaying that grant is handled by
-- the existing event and publication ledgers; it never creates another effect.
CREATE UNIQUE INDEX IF NOT EXISTS factory_approval_policy_once_idx
  ON factory_approvals (("decisionEvidence"->>'issuer'),"decisionCredentialId")
  WHERE "decisionCredentialId" IS NOT NULL;
CREATE TABLE IF NOT EXISTS factory_approval_controls (
  "taskId" uuid NOT NULL REFERENCES factory_tasks(id) ON DELETE CASCADE,
  "eventId" uuid NOT NULL, "userId" text NOT NULL, "principalId" text NOT NULL,
  request jsonb NOT NULL, result jsonb NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("taskId","eventId")
);
COMMIT;

-- #528 merges (same DDL as drizzle/20261030230000_factory_merges.sql).
CREATE TABLE IF NOT EXISTS factory_merges (
  id uuid PRIMARY KEY,
  "taskId" uuid NOT NULL REFERENCES factory_tasks(id) ON DELETE CASCADE,
  "candidateId" uuid NOT NULL,
  "userId" text NOT NULL,
  "eventId" uuid NOT NULL,
  "pullRequestUrl" text NOT NULL,
  sha text NOT NULL,
  status text NOT NULL CHECK (status IN ('merging','merged','failed')),
  source text NOT NULL CHECK (source IN ('mikka','github')),
  code text,
  "headSha" text,
  "mergeCommitSha" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "finishedAt" timestamptz,
  FOREIGN KEY ("taskId","candidateId") REFERENCES factory_candidates("taskId",id),
  UNIQUE ("taskId","eventId")
);
CREATE UNIQUE INDEX IF NOT EXISTS factory_merges_active_key
  ON factory_merges ("taskId","candidateId") WHERE status IN ('merging','merged');
