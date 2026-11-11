-- target: MIKKA_DATABASE_URL
-- Add references and consent metadata; historical grants, invoices and quantities remain unchanged.
ALTER TABLE workspace_billing
  ADD COLUMN "billingInvoiceId" text,
  ADD COLUMN "autoRechargeAmountPoints" integer CHECK ("autoRechargeAmountPoints" IS NULL OR "autoRechargeAmountPoints" IN (1000,2500,5000)),
  ADD COLUMN "autoRechargeConsentBy" text,
  ADD COLUMN "autoRechargeConsentAt" timestamptz,
  ADD COLUMN "autoRechargeRevision" integer NOT NULL DEFAULT 0 CHECK ("autoRechargeRevision">=0);
ALTER TABLE workspace_credit_grants
  ADD COLUMN "parentGrantId" uuid REFERENCES workspace_credit_grants(id),
  ADD COLUMN "stripeInvoiceId" text,
  ADD COLUMN "paymentAllocations" jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof("paymentAllocations")='object');
CREATE INDEX workspace_credit_grants_parent_idx ON workspace_credit_grants ("parentGrantId");
CREATE INDEX workspace_credit_grants_invoice_idx ON workspace_credit_grants ("stripeInvoiceId");
CREATE INDEX workspace_credit_grants_payments_idx ON workspace_credit_grants USING gin ("paymentAllocations");
-- A provider refund may precede its invoice. This inbox contains only payment metadata;
-- the existing credit-grant ledger is the sole balance authority.
CREATE TABLE billing_refund_receipts (
  id text PRIMARY KEY,
  "paymentIntentId" text NOT NULL,
  "chargeId" text NOT NULL,
  "amountCents" bigint NOT NULL CHECK ("amountCents">0),
  currency text NOT NULL CHECK (currency='usd'),
  "sourceEventId" text NOT NULL REFERENCES stripe_webhook_events(id),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "reconciledAt" timestamptz
);
CREATE INDEX billing_refund_payment_idx ON billing_refund_receipts ("paymentIntentId");
CREATE INDEX billing_refund_pending_idx ON billing_refund_receipts ("reconciledAt","createdAt");
