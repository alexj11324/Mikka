-- target: MIKKA_DATABASE_URL
-- Additive only. Preview must use an isolated branch; production runs separately.
BEGIN;
CREATE TABLE credentials (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  origin text NOT NULL,
  alt_origins text[] NOT NULL DEFAULT '{}',
  username text NOT NULL,
  auth_kind text NOT NULL DEFAULT 'password' CHECK (auth_kind IN ('password','oauth','session')),
  totp_mode text NOT NULL DEFAULT 'ask' CHECK (totp_mode IN ('ask','stored')),
  unattended_allowed boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  UNIQUE(user_id,origin,username),
  UNIQUE(id,user_id,origin)
);
CREATE TABLE credential_secrets (
  credential_id uuid PRIMARY KEY REFERENCES credentials(id) ON DELETE CASCADE,
  wrapped_dek text NOT NULL, nonce text NOT NULL, ciphertext text NOT NULL,
  aad_version integer NOT NULL DEFAULT 1 CHECK (aad_version=1),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE browser_sessions (
  credential_id uuid PRIMARY KEY REFERENCES credentials(id) ON DELETE CASCADE,
  wrapped_dek text NOT NULL, nonce text NOT NULL, ciphertext text NOT NULL,
  aad_version integer NOT NULL DEFAULT 1 CHECK (aad_version=1),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE credential_access_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  credential_id uuid REFERENCES credentials(id) ON DELETE SET NULL,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  bot_id uuid, run_id uuid, subagent_id uuid,
  origin_seen text NOT NULL,
  decision text NOT NULL,
  ts timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credential_access_owner_time ON credential_access_events(user_id,ts DESC);
-- Random single-use browser-form challenges and signed-OIDC broker leases. Values
-- are never stored, logged or exposed in model tools. Hashes expire in 30s/5min.
CREATE TABLE credential_challenges (
  nonce_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL, bot_id uuid NOT NULL,
  subagent_id uuid, run_id uuid,
  origin text NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE TABLE credential_fill_leases (
  nonce_hash text PRIMARY KEY,
  credential_id uuid NOT NULL,
  user_id text NOT NULL,
  origin text NOT NULL,
  workspace_id uuid NOT NULL, bot_id uuid NOT NULL,
  subagent_id uuid, run_id uuid,
  target jsonb NOT NULL,
  expires_at timestamptz NOT NULL, consumed_at timestamptz,
  FOREIGN KEY(credential_id,user_id,origin) REFERENCES credentials(id,user_id,origin) ON DELETE CASCADE
);
CREATE INDEX credential_fill_expiry ON credential_fill_leases(expires_at);
CREATE INDEX credential_challenge_expiry ON credential_challenges(expires_at);
COMMIT;
