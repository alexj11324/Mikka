-- The GitHub account a Mikka user connected on Plugins → GitHub, apart from
-- the Better Auth login identity. Any number of Mikka users may connect the
-- same GitHub account, so githubAccountId is deliberately not unique.
CREATE TABLE IF NOT EXISTS github_connections (
  "userId" text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  "githubAccountId" text NOT NULL,
  "githubLogin" text NOT NULL,
  "accessToken" text NOT NULL,
  "refreshToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
