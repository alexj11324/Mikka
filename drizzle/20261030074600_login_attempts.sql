-- target: MIKKA_DATABASE_URL
-- BE-17: status of a credential login attempt. Additive only.
-- Stores no credential, no code and no ciphertext: the pending credential lives only
-- in the memory of the runtime process that holds the browser session (10 min TTL).
BEGIN;
CREATE TABLE IF NOT EXISTS login_attempts (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  bot_id uuid NOT NULL,
  subagent_id uuid,
  run_id uuid,
  site text NOT NULL,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','needs_code','signed_in','rejected','expired')),
  reason text CHECK (reason IN ('twoFactorRequired','invalidCredentials','twoFactorInvalid','sessionLost','saveFailed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((subagent_id IS NULL) <> (run_id IS NULL)),
  CHECK ((status = 'needs_code') = (reason IS NOT DISTINCT FROM 'twoFactorRequired') OR status <> 'needs_code'),
  CHECK (status <> 'rejected' OR reason IN ('invalidCredentials','twoFactorInvalid')),
  CHECK (status <> 'signed_in' OR reason IS NULL)
);
CREATE INDEX IF NOT EXISTS login_attempts_owner_idx ON login_attempts (user_id, workspace_id, created_at DESC);
COMMIT;
