-- Mikka internal project decisions only. Conversation bodies are never copied here.
-- Workspace/project rows live in the separate workspace database: validate those in the service.
CREATE TABLE IF NOT EXISTS project_decisions (
  id uuid PRIMARY KEY,
  "workspaceId" uuid NOT NULL,
  "projectId" uuid NOT NULL,
  "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "issueId" uuid REFERENCES issues(id) ON DELETE SET NULL,
  "factoryTaskId" uuid REFERENCES factory_tasks(id) ON DELETE SET NULL,
  "runId" uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('choose','redirect','abandon','merge','confirm')),
  title varchar(200) NOT NULL,
  summary varchar(500) NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 4000),
  options jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) <= 20),
  "selectedOptionId" text,
  "contextOptionRef" jsonb,
  "predecessorDecisionIds" uuid[] NOT NULL DEFAULT '{}',
  provenance text NOT NULL CHECK (provenance IN ('recorded','inferred')),
  "captureMode" text NOT NULL CHECK ("captureMode" IN ('live','human_marked','reconstructed')),
  "decidedBy" jsonb NOT NULL,
  "recordedBy" jsonb NOT NULL,
  "occurredAt" timestamptz NOT NULL,
  "recordedAt" timestamptz NOT NULL DEFAULT now(),
  "supersedesId" uuid REFERENCES project_decisions(id) ON DELETE SET NULL,
  "recordStatus" text NOT NULL DEFAULT 'active' CHECK ("recordStatus" IN ('active','retracted')),
  "idempotencyKey" text NOT NULL,
  "payloadHash" text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS project_decisions_idempotency_idx ON project_decisions ("workspaceId","projectId","ownerId","idempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS project_decisions_supersedes_idx ON project_decisions ("supersedesId") WHERE "supersedesId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS project_decisions_project_time_idx ON project_decisions ("workspaceId","projectId","recordedAt",id);
CREATE INDEX IF NOT EXISTS project_decisions_run_idx ON project_decisions ("runId") WHERE "runId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS project_decisions_issue_idx ON project_decisions ("issueId") WHERE "issueId" IS NOT NULL;

CREATE TABLE IF NOT EXISTS project_decision_sources (
  id uuid PRIMARY KEY,
  "decisionId" uuid NOT NULL REFERENCES project_decisions(id) ON DELETE CASCADE,
  "ownerId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "workspaceId" uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('evidence','branch_work','stopped_at','merges_from')),
  "optionId" text,
  "sourceType" text NOT NULL,
  "sourceId" text NOT NULL,
  locator jsonb NOT NULL,
  relation text NOT NULL CHECK (relation IN ('host_verified','declared','inferred')),
  "normalizedKey" text NOT NULL,
  "verifiedAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS project_decision_sources_key_idx ON project_decision_sources ("decisionId","normalizedKey");
CREATE INDEX IF NOT EXISTS project_decision_sources_lookup_idx ON project_decision_sources ("workspaceId","sourceType","sourceId");
