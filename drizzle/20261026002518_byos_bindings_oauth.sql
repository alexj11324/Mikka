-- target: MIKKA_DATABASE_URL
-- Token values and PKCE verifiers remain in Infisical, never these tables.
begin;
set local lock_timeout = '5s';
alter table byos_connections add column if not exists quota jsonb;
create table if not exists byos_bindings (
  id uuid primary key,
  "ownerId" text not null,
  "workspaceId" text not null,
  "consumerId" text not null,
  "connectionId" uuid not null references byos_connections(id),
  "connectionRevision" bigint not null,
  route text not null check (route in ('codex_cpa','claude_cpa','codex_cli','claude_code_cli')),
  "modelId" text not null,
  "createdAt" timestamptz not null default now()
);
create index if not exists byos_bindings_owner_idx on byos_bindings ("ownerId", "workspaceId");
create index if not exists byos_bindings_consumer_idx on byos_bindings ("ownerId", "consumerId", "createdAt" desc);
create table if not exists byos_oauth_attempts (
  "stateHash" text primary key check ("stateHash" ~ '^[a-f0-9]{64}$'),
  "sessionHash" text not null,
  "connectionId" uuid not null references byos_connections(id),
  "ownerId" text not null,
  "workspaceId" text not null,
  "operationId" uuid not null,
  "secretName" text not null,
  "expiresAt" timestamptz not null,
  "consumedAt" timestamptz
);
create index if not exists byos_oauth_expiry_idx on byos_oauth_attempts ("expiresAt");
commit;
