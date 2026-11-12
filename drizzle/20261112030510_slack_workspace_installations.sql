-- target: MIKKA_DATABASE_URL
-- Slack grants are application secrets. Workspace membership is pinned in the separate workspace database.
CREATE TABLE mikka_slack_oauth_states (
  state_hash text PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('handoff','oauth')),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX mikka_slack_oauth_by_user ON mikka_slack_oauth_states(user_id, expires_at);

CREATE TABLE mikka_slack_installations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  app_id text NOT NULL,
  team_id text NOT NULL,
  team_name text NOT NULL,
  bot_user_id text NOT NULL,
  installed_by text NOT NULL,
  bot_secret jsonb NOT NULL,
  scopes text[] NOT NULL,
  installed_at timestamptz NOT NULL DEFAULT now(),
  revoking boolean NOT NULL DEFAULT false,
  UNIQUE (app_id, team_id),
  UNIQUE (workspace_id, app_id)
);

CREATE TABLE mikka_slack_members (
  installation_id uuid NOT NULL REFERENCES mikka_slack_installations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  slack_user_id text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  enabled boolean NOT NULL DEFAULT true,
  watched_channels text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (installation_id, user_id),
  UNIQUE (installation_id, slack_user_id),
  CHECK (cardinality(watched_channels) <= 100)
);
