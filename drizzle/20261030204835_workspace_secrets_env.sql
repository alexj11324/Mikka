-- target: MIKKA_DATABASE_URL
-- Settings › 密钥与环境 (plan 1.3, appendix A3) and the bring-your-own E2B key
-- (plan 1.3.1). Values are AES-256-GCM ciphertext under WORKSPACE_SECRETS_KEY;
-- plaintext is never stored. "workspaceId" has no FK: workspaces live in the
-- workspace database (DATABASE_URL). Mirrors lib/db/secrets-schema.ts.
-- Rollback: drop table workspace_e2b_keys, workspace_secrets;
--           delete from schema_migrations where name = '20261030204835_workspace_secrets_env.sql';

create table if not exists workspace_secrets (
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
    -- owner/repo, stored lowercase; '.' and '..' are not segments.
    or ("scopeType" = 'repository' and "scopeRef" ~ '^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$'
        and "scopeRef" !~ '(^|/)\.{1,2}(/|$)'))
);
create unique index if not exists workspace_secrets_name_key on workspace_secrets ("workspaceId", "scopeType", "scopeRef", name);

-- One E2B API key per workspace. Write-only: only last4 / verifiedAt are ever shown.
create table if not exists workspace_e2b_keys (
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
