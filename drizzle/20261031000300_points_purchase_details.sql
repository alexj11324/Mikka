ALTER TABLE workspace_credit_grants
  ADD COLUMN "stripePaymentIntentId" text,
  ADD COLUMN "amountCents" integer,
  ADD COLUMN currency text,
  ADD COLUMN "receiptUrl" text,
  ADD COLUMN "stripeFeeCents" integer;

CREATE INDEX workspace_credit_grants_payment_intent_idx
  ON workspace_credit_grants ("stripePaymentIntentId");
