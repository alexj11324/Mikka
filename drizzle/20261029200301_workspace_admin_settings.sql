-- target: MIKKA_DATABASE_URL
-- Workspace settings › Bots / Usage / Billing. Lives beside bots and agent_runs so
-- the run admission gate reads limits and credits in the same transaction.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE IF NOT EXISTS workspace_settings (
  "workspaceId" uuid PRIMARY KEY,
  "defaultModel" text CHECK ("defaultModel" IN ('mikka', 'codex', 'claude')),
  "defaultRepository" text CHECK (length("defaultRepository") BETWEEN 1 AND 300),
  "monthlyCreditLimit" integer CHECK ("monthlyCreditLimit" >= 0),
  "botMonthlyCreditLimit" integer CHECK ("botMonthlyCreditLimit" >= 0),
  "backgroundDailyCreditLimit" integer CHECK ("backgroundDailyCreditLimit" >= 0),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

-- What a new bot starts with (copied from workspace_settings when createBot omits them).
ALTER TABLE bots ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE bots ADD COLUMN IF NOT EXISTS repository text;
-- Per-bot monthly credit cap; null falls back to workspace_settings."botMonthlyCreditLimit".
ALTER TABLE bots ADD COLUMN IF NOT EXISTS "monthlyCreditLimit" integer CHECK ("monthlyCreditLimit" >= 0);

-- Handing a bot to another member rewrites bots."ownerId". Finished background
-- tasks follow it. Owner-bound rows (desktops, cloud runtimes, run bindings and
-- the immutable agent-kit history, whose identity includes the owner) are
-- removed by the transfer itself.
ALTER TABLE bot_subagents DROP CONSTRAINT IF EXISTS "bot_subagents_botId_workspaceId_ownerId_fkey";
ALTER TABLE bot_subagents ADD CONSTRAINT "bot_subagents_botId_workspaceId_ownerId_fkey" FOREIGN KEY ("botId", "workspaceId", "ownerId") REFERENCES bots(id, "workspaceId", "ownerId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Billing (Stripe). One row per workspace that ever started a checkout.
CREATE TABLE IF NOT EXISTS workspace_billing (
  "workspaceId" uuid PRIMARY KEY,
  "stripeCustomerId" text UNIQUE,
  "stripeSubscriptionId" text UNIQUE,
  plan text,
  status text,
  seats integer NOT NULL DEFAULT 0 CHECK (seats >= 0),
  "currentPeriodEnd" timestamptz,
  "autoRechargeEnabled" boolean NOT NULL DEFAULT false,
  "autoRechargeThreshold" integer CHECK ("autoRechargeThreshold" >= 0),
  "autoRechargePacks" integer CHECK ("autoRechargePacks" BETWEEN 1 AND 100),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

-- Credit grants: 'plan' points arrive with each paid subscription invoice and
-- replace the previous period's; 'purchased' points never expire. Usage is
-- derived from agent_runs / bot_subagents, so the ledger only records grants.
CREATE TABLE IF NOT EXISTS workspace_credit_grants (
  id uuid PRIMARY KEY,
  "workspaceId" uuid NOT NULL,
  bucket text NOT NULL CHECK (bucket IN ('plan', 'purchased')),
  points integer NOT NULL,
  reason text NOT NULL,
  "externalId" text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspace_credit_grants_workspace_idx ON workspace_credit_grants ("workspaceId", "createdAt");

-- Stripe retries webhooks; each event id is applied once.
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  "processedAt" timestamptz NOT NULL DEFAULT now()
);
COMMIT;
