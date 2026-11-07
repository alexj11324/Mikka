CREATE TABLE cloud_github_installations (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  installation_id text NOT NULL CHECK (installation_id ~ '^[1-9][0-9]*$'),
  account_id text NOT NULL,
  account_login text NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('User','Organization')),
  github_account_id text,
  cloud_subject text NOT NULL,
  cloud_workspace_id uuid NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,installation_id)
);
CREATE INDEX cloud_github_accounts ON cloud_github_installations(github_account_id) WHERE github_account_id IS NOT NULL;

CREATE TABLE cloud_github_repositories (
  user_id text NOT NULL,
  remote_key text NOT NULL,
  installation_id text NOT NULL,
  repository_id text NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,remote_key),
  FOREIGN KEY(user_id,installation_id) REFERENCES cloud_github_installations(user_id,installation_id) ON DELETE CASCADE
);

CREATE TABLE cloud_github_webhook_receipts (
  delivery_id varchar(100) PRIMARY KEY,
  event varchar(100) NOT NULL,
  body_hash char(64) NOT NULL,
  lease_until timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
