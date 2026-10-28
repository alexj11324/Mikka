-- target: MIKKA_DATABASE_URL
-- Metadata and publication fencing only. Provider credentials stay in Infisical.
begin;
set local lock_timeout = '5s';

create table if not exists byos_connections (
  id uuid primary key,
  "ownerId" text not null,
  "workspaceId" text not null,
  provider text not null check (provider in ('codex', 'claude')),
  state text not null default 'disconnected' check (state in
    ('pending', 'connected', 'refreshing', 'publication_pending', 'reconnect_required', 'disconnected')),
  epoch bigint not null default 1 check (epoch > 0),
  "credentialVersion" bigint not null default 0 check ("credentialVersion" >= 0),
  -- Opaque immutable Infisical secret names, never token values or JSON auth blobs.
  "secretName" text,
  "secretDigest" text,
  "providerSubject" text,
  "operationId" uuid,
  "operationKind" text check ("operationKind" in ('acquire', 'refresh')),
  "operationDeadline" timestamptz,
  "stagedSecretName" text,
  "stagedDigest" text,
  "lastErrorCode" text check ("lastErrorCode" in
    ('publication_failed', 'refresh_failed', 'publication_missing', 'integrity_failed')),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  check (("secretName" is null) = ("secretDigest" is null)),
  check ("secretDigest" is null or "secretDigest" ~ '^[a-f0-9]{64}$'),
  check ("stagedDigest" is null or "stagedDigest" ~ '^[a-f0-9]{64}$'),
  check (("operationId" is null) = ("operationKind" is null)),
  check (("operationId" is null) = ("operationDeadline" is null)),
  check (state <> 'connected' or ("secretName" is not null and "providerSubject" is not null and "operationId" is null)),
  check (state <> 'publication_pending' or ("operationId" is not null and "stagedSecretName" is not null and "stagedDigest" is not null))
);
create index if not exists byos_connections_owner_workspace_idx
  on byos_connections ("ownerId", "workspaceId");
create unique index if not exists byos_connections_operation_idx
  on byos_connections ("operationId") where "operationId" is not null;
create unique index if not exists byos_connections_secret_idx
  on byos_connections ("secretName") where "secretName" is not null;

commit;
