-- target: MIKKA_DATABASE_URL
-- Metadata-only one-time escrow ownership/publication fence. No token values.
begin;
set local lock_timeout = '5s';
create table if not exists byos_enrollment_transfers (
  "enrollmentId" uuid primary key,
  "transferId" uuid not null unique,
  "connectionId" uuid not null unique references byos_connections(id),
  "ownerId" text not null,
  "workspaceId" text not null,
  principal text not null,
  "databaseIdentity" text not null check ("databaseIdentity" ~ '^[a-f0-9]{64}$'),
  "escrowDigest" text not null check ("escrowDigest" ~ '^[a-f0-9]{64}$'),
  "providerSubject" text not null,
  epoch bigint not null check (epoch > 0),
  "operationId" uuid not null,
  "boundAt" timestamptz,
  "createdAt" timestamptz not null default now()
);
commit;
