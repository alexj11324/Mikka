-- 「API 与订阅」(orchestration.md § 1, § 6; conflict C22): API keys and custom
-- providers are model credentials bound to the account, next to the Claude and
-- ChatGPT subscriptions. The key is sealed with WORKSPACE_SECRETS_KEY
-- (lib/secrets/crypto.ts) and never read back; only its last four characters
-- are shown. A key is used in a team workspace by its owner's own bots when
-- the owner shares their subscriptions there (workspace_subscription_shares),
-- and by other members' bots only after the owner ticks 分享给团队成员 for
-- that key in that workspace (model_api_key_shares).
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE IF NOT EXISTS model_api_keys (
  id uuid PRIMARY KEY,
  "ownerId" text NOT NULL,
  -- anthropic | openai | deepseek | kimi | custom
  provider text NOT NULL,
  -- A custom provider's own name, base URL and protocol; null for the presets.
  name text,
  "baseUrl" text,
  protocol text NOT NULL CHECK (protocol IN ('anthropic', 'openai')),
  ciphertext text NOT NULL,
  iv text NOT NULL,
  "keyVersion" integer NOT NULL,
  last4 text NOT NULL,
  models jsonb NOT NULL DEFAULT '[]'::jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS model_api_keys_owner_idx ON model_api_keys ("ownerId");
-- One key per preset provider; any number of custom providers.
CREATE UNIQUE INDEX IF NOT EXISTS model_api_keys_owner_provider_key ON model_api_keys ("ownerId", provider) WHERE provider <> 'custom';
CREATE TABLE IF NOT EXISTS model_api_key_shares (
  "keyId" uuid NOT NULL REFERENCES model_api_keys(id) ON DELETE CASCADE,
  "workspaceId" uuid NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("keyId", "workspaceId")
);
CREATE INDEX IF NOT EXISTS model_api_key_shares_workspace_idx ON model_api_key_shares ("workspaceId");
-- Which key each run was handed (apiKeyForRun), so withdrawing a key or its
-- share stops those runs at once (orchestration.md § 2: no switch mid-run).
CREATE TABLE IF NOT EXISTS model_api_key_runs (
  "runId" uuid PRIMARY KEY,
  "keyId" uuid NOT NULL,
  "workspaceId" uuid,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS model_api_key_runs_key_idx ON model_api_key_runs ("keyId");
-- 「订阅额度用完后，自动改用 API Key」, on by default (orchestration.md § 2).
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "apiKeyAfterQuota" boolean NOT NULL DEFAULT true;
COMMIT;
