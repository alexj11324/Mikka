-- Plugins → GitHub from a desktop app that can take the return on its own
-- loopback address (RFC 8252 §7.3). The link is for the app's account whatever
-- the browser is signed in as; GitHub's answer waits here, sealed, until the
-- app proves the return reached this computer by sending the verifier only it
-- holds (appChallenge = base64url(sha256(verifier))). PKCE runs between the
-- server and GitHub with codeVerifier.
ALTER TABLE github_connect_intents
  ADD COLUMN IF NOT EXISTS "appChallenge" text,
  ADD COLUMN IF NOT EXISTS "returnTo" text,
  ADD COLUMN IF NOT EXISTS "returnState" text,
  ADD COLUMN IF NOT EXISTS "stateHash" text,
  ADD COLUMN IF NOT EXISTS "codeVerifier" text,
  ADD COLUMN IF NOT EXISTS "githubAccountId" text,
  ADD COLUMN IF NOT EXISTS "githubLogin" text,
  ADD COLUMN IF NOT EXISTS "accessToken" text,
  ADD COLUMN IF NOT EXISTS "refreshToken" text,
  ADD COLUMN IF NOT EXISTS "accessTokenExpiresAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "refreshTokenExpiresAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "authorizedAt" timestamptz,
  ADD COLUMN IF NOT EXISTS "confirmedAt" timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS github_connect_intents_state ON github_connect_intents ("stateHash") WHERE "stateHash" IS NOT NULL;
