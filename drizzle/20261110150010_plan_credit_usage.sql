-- target: MIKKA_DATABASE_URL
-- Extend the existing receipt ledger. Old rows remain byte-for-byte unchanged apart from additive defaults.
ALTER TABLE hosted_usage
  ADD COLUMN "usageWorkspaceId" uuid,
  ADD COLUMN "billingOrganizationId" uuid,
  ADD COLUMN "executionOwnerId" text,
  ADD COLUMN "planMicroUsd" bigint NOT NULL DEFAULT 0 CHECK ("planMicroUsd">=0),
  ADD COLUMN "planAllocations" jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof("planAllocations")='object');
CREATE INDEX hosted_usage_attribution_idx ON hosted_usage ("usageWorkspaceId","createdAt");
CREATE INDEX hosted_usage_organization_idx ON hosted_usage ("billingOrganizationId","createdAt") WHERE "billingOrganizationId" IS NOT NULL;
