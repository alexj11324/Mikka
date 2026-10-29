-- target: MIKKA_DATABASE_URL
-- Tables for better-auth's twoFactor plugin (better-auth 1.7.12) and the
-- @better-auth/passkey plugin (lib/auth.ts). Columns follow each plugin's
-- schema; passkey."lastUsedAt" is Mikka's own and is written by the passkey
-- plugin's afterVerification hook. IF NOT EXISTS makes a retry safe.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "twoFactorEnabled" boolean DEFAULT false;
CREATE TABLE IF NOT EXISTS "twoFactor" (
  "id" text NOT NULL PRIMARY KEY,
  "secret" text NOT NULL,
  "backupCodes" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "verified" boolean DEFAULT true,
  "failedVerificationCount" integer DEFAULT 0,
  "lockedUntil" timestamptz
);
CREATE INDEX IF NOT EXISTS "twoFactor_secret_idx" ON "twoFactor" ("secret");
CREATE INDEX IF NOT EXISTS "twoFactor_userId_idx" ON "twoFactor" ("userId");
CREATE TABLE IF NOT EXISTS "passkey" (
  "id" text NOT NULL PRIMARY KEY,
  "name" text,
  "publicKey" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "credentialID" text NOT NULL,
  "counter" integer NOT NULL,
  "deviceType" text NOT NULL,
  "backedUp" boolean NOT NULL,
  "transports" text,
  "createdAt" timestamptz,
  "aaguid" text,
  "lastUsedAt" timestamptz
);
CREATE INDEX IF NOT EXISTS "passkey_userId_idx" ON "passkey" ("userId");
CREATE INDEX IF NOT EXISTS "passkey_credentialID_idx" ON "passkey" ("credentialID");
COMMIT;
