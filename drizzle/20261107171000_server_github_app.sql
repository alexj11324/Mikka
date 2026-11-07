-- A self-hosted server owns one GitHub App. All six returned credentials,
-- including the App id/slug, are one authenticated encrypted payload.
CREATE TABLE IF NOT EXISTS server_github_app (
  id integer PRIMARY KEY DEFAULT 1 CONSTRAINT server_github_app_singleton CHECK (id = 1),
  ciphertext text NOT NULL,
  iv text NOT NULL,
  "keyVersion" integer NOT NULL,
  "createdBy" text REFERENCES "user"(id) ON DELETE SET NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

-- One pending registration per administrator, bound to their current browser
-- session and exact application origin. Only the random state's hash is kept.
CREATE TABLE IF NOT EXISTS github_app_manifest_intents (
  "stateHash" text PRIMARY KEY,
  "userId" text NOT NULL UNIQUE REFERENCES "user"(id) ON DELETE CASCADE,
  "sessionId" text NOT NULL,
  origin text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
