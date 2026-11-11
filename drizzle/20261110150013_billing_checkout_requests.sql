-- target: MIKKA_DATABASE_URL
-- Request receipts preserve Stripe idempotency across transport failures. This is not a credits ledger.
CREATE TABLE billing_checkout_requests (
  id uuid PRIMARY KEY,
  "workspaceId" uuid NOT NULL REFERENCES workspace_billing("workspaceId"),
  "actorId" text NOT NULL,
  "customerId" text NOT NULL,
  "priceId" text NOT NULL,
  params jsonb NOT NULL CHECK (jsonb_typeof(params)='object'),
  "sessionId" text UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "expiresAt" timestamptz NOT NULL,
  "closedAt" timestamptz,
  CHECK ("expiresAt">"createdAt")
);
CREATE UNIQUE INDEX billing_checkout_requests_active_idx ON billing_checkout_requests("workspaceId") WHERE "closedAt" IS NULL;
