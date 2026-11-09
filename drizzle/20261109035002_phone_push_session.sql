-- target: MIKKA_DATABASE_URL
-- Bind phone destinations only when the native session registers them again.
-- Historical rows remain NULL and inert; neither userId nor task scope can
-- identify which session installed a token. No session FK: delivery validates
-- fresh ownership/expiry and holds the appropriate revocation barrier.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE mobile_push_tokens ADD COLUMN IF NOT EXISTS "sessionId" text;

COMMIT;
