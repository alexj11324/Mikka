-- target: MIKKA_DATABASE_URL
ALTER TABLE hosted_usage
  ADD COLUMN "actorId" text,
  ADD COLUMN "usageProjectId" uuid,
  ADD COLUMN "usageThreadId" uuid,
  ADD COLUMN "usageRunId" uuid,
  ADD COLUMN "attributionComplete" boolean NOT NULL DEFAULT false;
CREATE TABLE billing_resource_budgets (
  id uuid PRIMARY KEY,
  "workspaceId" uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('workspace','member','project','thread','run')),
  "scopeId" text NOT NULL,
  period text NOT NULL CHECK (period IN ('month','day','lifetime')),
  "limitPoints" integer NOT NULL CHECK ("limitPoints" BETWEEN 0 AND 100000000),
  "warningPercent" integer NOT NULL DEFAULT 80 CHECK ("warningPercent" BETWEEN 1 AND 100),
  "updatedBy" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("workspaceId",scope,"scopeId",period)
);
CREATE INDEX billing_resource_budgets_workspace_idx ON billing_resource_budgets ("workspaceId");
