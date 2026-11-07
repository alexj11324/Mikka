-- Self-hosted client state only. Cloud issuer/billing tables stay in mikka-cloud.
CREATE TABLE cloud_service_registration (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  server_id uuid NOT NULL UNIQUE,
  origin text NOT NULL,
  base_path text NOT NULL,
  service_url text NOT NULL,
  secret jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cloud_service_bindings (
  owner text PRIMARY KEY,
  user_id text REFERENCES "user"(id) ON DELETE CASCADE,
  server_id uuid NOT NULL REFERENCES cloud_service_registration(server_id) ON DELETE CASCADE,
  secret jsonb NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  revoked boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((owner = 'server' AND user_id IS NULL) OR (owner = 'user:' || user_id AND user_id IS NOT NULL))
);
CREATE TABLE cloud_service_states (
  state_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  session_hash text NOT NULL,
  server_id uuid NOT NULL REFERENCES cloud_service_registration(server_id) ON DELETE CASCADE,
  secret jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cloud_service_states_expiry_idx ON cloud_service_states (expires_at);
