BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "deviceCode" (
  id text PRIMARY KEY,
  "deviceCode" text NOT NULL,
  "userCode" text NOT NULL,
  "userId" text,
  "expiresAt" timestamptz NOT NULL,
  status text NOT NULL,
  "lastPolledAt" timestamptz,
  "pollingInterval" integer,
  "clientId" text,
  scope text
);
CREATE UNIQUE INDEX IF NOT EXISTS device_code_key ON "deviceCode" ("deviceCode");
CREATE UNIQUE INDEX IF NOT EXISTS device_user_code_key ON "deviceCode" ("userCode");

COMMIT;
