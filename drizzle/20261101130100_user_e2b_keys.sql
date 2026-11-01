-- target: MIKKA_DATABASE_URL
-- An E2B key belongs to one person (orchestration § 2, Alex: a sandbox carries
-- its owner's credentials, so member A never runs on member B's key). Values are
-- AES-256-GCM ciphertext under WORKSPACE_SECRETS_KEY, bound to the user id.
-- Existing workspace keys cannot be re-sealed in SQL (their ciphertext is bound
-- to the workspace id): lib/secrets/e2b.ts moves one to its creator on first use
-- and drops the workspace row. Additive and idempotent.
-- Rollback: drop table user_e2b_keys;
--           delete from schema_migrations where name = '20261101130100_user_e2b_keys.sql';
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS user_e2b_keys (
  "userId" text PRIMARY KEY,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  "keyVersion" integer NOT NULL CHECK ("keyVersion" >= 1),
  last4 text NOT NULL CHECK (length(last4) = 4),
  "e2bTeamHint" text CHECK (length("e2bTeamHint") <= 120),
  "verifiedAt" timestamptz,
  "lastErrorCode" text CHECK ("lastErrorCode" IN ('invalid', 'rate_limited', 'template_unavailable', 'unavailable')),
  "lastErrorAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
COMMIT;
