-- target: MIKKA_DATABASE_URL
-- Additive only: legacy balances, receipts, subscription ids and seat quantities remain unchanged.
ALTER TABLE workspace_billing
  ADD COLUMN "billingModel" text NOT NULL DEFAULT 'legacy_seat' CHECK ("billingModel" IN ('legacy_seat','resource_v1')),
  ADD COLUMN "stripePriceId" text,
  ADD COLUMN "billingPlan" text NOT NULL DEFAULT 'free' CHECK ("billingPlan" IN ('free','pro','enterprise')),
  ADD COLUMN "billingExpiresAt" timestamptz,
  ADD COLUMN "billingRevision" bigint NOT NULL DEFAULT 0 CHECK ("billingRevision">=0),
  ADD COLUMN "autoRechargeMonthlyCap" integer CHECK ("autoRechargeMonthlyCap" IS NULL OR "autoRechargeMonthlyCap">=0);
ALTER TABLE workspace_credit_grants
  ADD COLUMN "periodStart" timestamptz,
  ADD COLUMN "expiresAt" timestamptz,
  ADD CONSTRAINT workspace_credit_grant_period CHECK ("expiresAt" IS NULL OR "periodStart" IS NULL OR "expiresAt">"periodStart");
CREATE TABLE billing_entitlement_outbox (
  "eventId" text PRIMARY KEY REFERENCES stripe_webhook_events(id),
  "workspaceId" uuid NOT NULL, "subscriptionId" text NOT NULL,
  plan text NOT NULL CHECK (plan IN ('free','pro','enterprise')), "expiresAt" timestamptz,
  revision bigint NOT NULL CHECK (revision>0),
  "billingModel" text NOT NULL CHECK ("billingModel" IN ('legacy_seat','resource_v1')),
  "createdAt" timestamptz NOT NULL DEFAULT now(), "deliveredAt" timestamptz,
  UNIQUE ("workspaceId",revision)
);
CREATE INDEX billing_entitlement_pending_idx ON billing_entitlement_outbox ("workspaceId","deliveredAt",revision);
