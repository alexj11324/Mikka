-- target: MIKKA_DATABASE_URL
-- A Composio connected account whose provider refused the person's own
-- authorization (a revoked or expired token) while Composio still lists it as
-- ACTIVE. The connected-apps list shows it as needing reconnection; it clears
-- once a read through it works again, and a reconnect retires the row.
ALTER TABLE composio_accounts ADD COLUMN IF NOT EXISTS "needsReconnectAt" timestamptz;
