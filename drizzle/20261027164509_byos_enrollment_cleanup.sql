-- target: MIKKA_DATABASE_URL
-- Source-store cleanup metadata only; no provider tokens or PKCE values.
begin;
set local lock_timeout = '5s';
alter table byos_enrollment_transfers add column if not exists "claimConfirmedAt" timestamptz;
alter table byos_enrollment_transfers add column if not exists "canonicalPublishedAt" timestamptz;
alter table byos_enrollment_transfers add column if not exists "sourceCreationState" text not null default 'unknown' check ("sourceCreationState" in ('unknown','settled','uncertain'));
alter table byos_enrollment_transfers add column if not exists "attemptCreationSettled" boolean not null default false;
update byos_enrollment_transfers set "canonicalPublishedAt"="boundAt" where "canonicalPublishedAt" is null and "boundAt" is not null;
create table if not exists byos_enrollment_sources (
  "enrollmentId" uuid not null references byos_enrollment_transfers("enrollmentId") on delete cascade,
  kind text not null check (kind in ('escrow','attempt')),
  "connectionId" uuid not null references byos_connections(id) on delete cascade,
  "deletedAt" timestamptz,
  "lastAttemptAt" timestamptz,
  "lastError" text,
  primary key ("enrollmentId",kind)
);
insert into byos_enrollment_sources ("enrollmentId",kind,"connectionId") select t."enrollmentId",k.kind,t."connectionId" from byos_enrollment_transfers t cross join (values ('escrow'),('attempt')) k(kind) on conflict do nothing;
create index if not exists byos_enrollment_sources_retry_idx on byos_enrollment_sources("connectionId","lastAttemptAt") where "deletedAt" is null;
commit;
