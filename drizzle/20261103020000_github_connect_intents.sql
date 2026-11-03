-- Plugins → GitHub from the desktop app: the account that started a link,
-- named by a one-time token the app hands to the system browser. Only a hash
-- of the token is stored. The browser's own session must be that account; a
-- browser signed in as someone else is recorded so both sides can say so.
CREATE TABLE IF NOT EXISTS github_connect_intents (
  "tokenHash" text PRIMARY KEY,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "expiresAt" timestamptz NOT NULL,
  "usedAt" timestamptz,
  "browserUserId" text REFERENCES "user"(id) ON DELETE SET NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS github_connect_intents_user ON github_connect_intents ("userId", "createdAt");
