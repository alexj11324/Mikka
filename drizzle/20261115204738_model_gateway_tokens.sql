-- target: MIKKA_DATABASE_URL

-- The Mikka model gateway (decision 2026-11-15-2000). A thread whose model is
-- paid by Mikka 额度 or by the person's own API key gets only a short-lived
-- token for the gateway, never a provider key. Only the token's SHA-256 is
-- stored; it is bound to one run and the source frozen with that run, and it
-- stops working once the run is no longer active or the token expires.
--
-- A custom endpoint may turn off request features it does not accept, as
-- Capy's connections do: strict tool schemas, custom tools, fallbacks and
-- thinking. Absent means on.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
CREATE TABLE IF NOT EXISTS model_gateway_tokens (
  "tokenHash" text PRIMARY KEY CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
  "runId" uuid NOT NULL,
  "ownerId" text NOT NULL,
  "workspaceId" uuid,
  harness text NOT NULL CHECK (harness IN ('claude_code', 'codex')),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 128),
  "sourceKind" text NOT NULL CHECK ("sourceKind" IN ('credits', 'api_key')),
  "keyId" uuid,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT model_gateway_tokens_source CHECK (("sourceKind" = 'api_key') = ("keyId" IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS model_gateway_tokens_run ON model_gateway_tokens ("runId");
ALTER TABLE model_api_keys ADD COLUMN IF NOT EXISTS features jsonb;
COMMIT;
