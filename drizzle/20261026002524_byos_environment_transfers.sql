-- target: MIKKA_DATABASE_URL
-- Metadata-only cross-environment approval journal; source secrets never GC here.
begin;
set local lock_timeout = '5s';
create table if not exists byos_environment_transfers (
  "enrollmentId" uuid primary key,
  "approvalId" uuid not null unique,
  "approvalDigest" text not null check ("approvalDigest" ~ '^[a-f0-9]{64}$'),
  "ownerId" text not null,
  "workspaceId" text not null,
  "databaseIdentity" text not null check ("databaseIdentity" ~ '^[a-f0-9]{64}$'),
  "sourceDigest" text not null check ("sourceDigest" ~ '^[a-f0-9]{64}$'),
  "sourceRevision" integer not null check ("sourceRevision" = 1),
  "retainSource" boolean not null default true check ("retainSource"),
  "createdAt" timestamptz not null default now(),
  "verifiedAt" timestamptz
);
commit;
