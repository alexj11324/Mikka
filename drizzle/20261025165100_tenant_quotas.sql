-- Admission units are operator-defined execution allowances, never currency,
-- subscription credits, or a promise about a provider's unknown monetary cost.
-- Platform operator authorization is separate from a tenant administrator's
-- preferences. This table has no public mutation route and no seeded grants.
CREATE TABLE IF NOT EXISTS quota_allocations (
  workspace_id uuid PRIMARY KEY,
  max_budget_units bigint NOT NULL CHECK (max_budget_units >= 0 AND max_budget_units <= 9007199254740991),
  max_concurrency integer NOT NULL CHECK (max_concurrency > 0),
  max_rate_limit integer NOT NULL CHECK (max_rate_limit > 0),
  resources jsonb NOT NULL CHECK (jsonb_typeof(resources)='object'),
  expires_at timestamptz NOT NULL,
  granted_by text NOT NULL,
  reason text NOT NULL CHECK (length(reason)>0),
  revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS quota_tenants (
  workspace_id uuid PRIMARY KEY,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  budget_units bigint NOT NULL CHECK (budget_units >= 0 AND budget_units <= 9007199254740991),
  concurrency_limit integer NOT NULL CHECK (concurrency_limit > 0),
  rate_limit integer NOT NULL CHECK (rate_limit > 0),
  rate_window_seconds integer NOT NULL CHECK (rate_window_seconds BETWEEN 1 AND 86400),
  resources jsonb NOT NULL CHECK (jsonb_typeof(resources) = 'object'),
  paused boolean NOT NULL DEFAULT false,
  override_units bigint CHECK (override_units >= 0 AND override_units <= 9007199254740991),
  override_until timestamptz,
  override_by text,
  override_reason text,
  CHECK (window_end > window_start),
  CHECK ((override_units IS NULL AND override_until IS NULL AND override_by IS NULL AND override_reason IS NULL)
    OR (override_units IS NOT NULL AND override_until IS NOT NULL AND override_by IS NOT NULL AND length(override_reason) > 0 AND override_until <= window_end))
);
-- Existing execution paths are owner-scoped and have no workspace argument.
-- An owner has one explicit billing tenant; caller cookies cannot switch it.
CREATE TABLE IF NOT EXISTS quota_owners (
  owner_id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES quota_tenants(workspace_id)
);
CREATE TABLE IF NOT EXISTS quota_reservations (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES quota_owners(owner_id),
  workspace_id uuid NOT NULL REFERENCES quota_tenants(workspace_id),
  request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 256),
  resource text NOT NULL,
  fingerprint text NOT NULL,
  units bigint NOT NULL CHECK (units >= 0 AND units <= 9007199254740991),
  settled_units bigint CHECK (settled_units >= 0 AND settled_units <= units),
  state text NOT NULL CHECK (state IN ('reserved','executing','settled','refunded','uncertain')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  finished_at timestamptz,
  usage jsonb,
  UNIQUE(owner_id, request_key),
  CHECK ((state IN ('reserved','executing') AND settled_units IS NULL AND finished_at IS NULL)
    OR (state IN ('settled','refunded','uncertain') AND settled_units IS NOT NULL AND finished_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS quota_reservations_tenant_window ON quota_reservations(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS quota_reservations_live ON quota_reservations(workspace_id, expires_at) WHERE state IN ('reserved','executing');
CREATE TABLE IF NOT EXISTS quota_backoffs (
  workspace_id uuid NOT NULL REFERENCES quota_tenants(workspace_id),
  resource text NOT NULL,
  retry_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id, resource)
);
CREATE TABLE IF NOT EXISTS quota_policy_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES quota_tenants(workspace_id),
  actor text NOT NULL,
  policy jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "quotaReservationId" uuid REFERENCES quota_reservations(id);
