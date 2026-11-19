-- target: MIKKA_DATABASE_URL

-- Decision 2026-11-17-2215: a device is online while its gateway socket is
-- open. The gateway reports `connected` and `disconnected`; the socket that
-- opened last owns the session, so a late close of a replaced socket is ignored.
-- Existing devices start offline until their daemon (updated) opens a socket.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS "sessionOpenedAt" timestamptz;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS "sessionClosedAt" timestamptz;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS "sessionSocketId" text;
