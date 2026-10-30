-- target: MIKKA_DATABASE_URL
-- Settings › 密钥与环境 (plan 1.3, appendix A3) and the bring-your-own E2B key
-- (plan 1.3.1). Values are AES-256-GCM ciphertext under WORKSPACE_SECRETS_KEY;
-- plaintext is never stored. "workspaceId" has no FK: workspaces live in the
-- workspace database (DATABASE_URL). Mirrors lib/db/secrets-schema.ts.
-- Rollback: drop table workspace_e2b_verify_attempts, workspace_e2b_keys, workspace_network_policy, workspace_secrets;

create table workspace_secrets (
  id uuid primary key,
  "workspaceId" uuid not null,
  name text not null check (name ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'),
  kind text not null check (kind in ('secret', 'env')),
  "scopeType" text not null check ("scopeType" in ('workspace', 'repository')),
  -- '' for workspace scope (so the unique key works without NULL semantics), owner/repo for repository scope.
  "scopeRef" text not null default '',
  ciphertext text not null,
  iv text not null,
  "keyVersion" integer not null check ("keyVersion" >= 1),
  "createdBy" text not null,
  "updatedBy" text not null,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  constraint workspace_secrets_scope_ref check (
    ("scopeType" = 'workspace' and "scopeRef" = '')
    or ("scopeType" = 'repository' and "scopeRef" ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'))
);
create unique index workspace_secrets_name_key on workspace_secrets ("workspaceId", "scopeType", "scopeRef", name);

-- Outbound network (SEC-18/19): exactly one of open | allowlist | none.
create table workspace_network_policy (
  "workspaceId" uuid primary key,
  mode text not null default 'open' check (mode in ('open', 'allowlist', 'none')),
  "allowedDomains" text[] not null default '{}' check (cardinality("allowedDomains") <= 200),
  "updatedBy" text not null,
  "updatedAt" timestamptz not null default now()
);

-- One E2B API key per workspace. Write-only: only last4 / verifiedAt are ever shown.
create table workspace_e2b_keys (
  "workspaceId" uuid primary key,
  ciphertext text not null,
  iv text not null,
  "keyVersion" integer not null check ("keyVersion" >= 1),
  last4 text not null check (length(last4) = 4),
  "e2bTeamHint" text check (length("e2bTeamHint") <= 120),
  "verifiedAt" timestamptz,
  "lastErrorCode" text check ("lastErrorCode" in ('invalid', 'rate_limited', 'template_unavailable', 'unavailable')),
  "lastErrorAt" timestamptz,
  "createdBy" text not null,
  "updatedBy" text not null,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

-- BYO key verify rate limit (5 per workspace per 10 min), strict across instances.
create table workspace_e2b_verify_attempts (
  id bigserial primary key,
  "workspaceId" uuid not null,
  "attemptedAt" timestamptz not null
);
create index workspace_e2b_verify_attempts_ws_idx on workspace_e2b_verify_attempts ("workspaceId", "attemptedAt");
