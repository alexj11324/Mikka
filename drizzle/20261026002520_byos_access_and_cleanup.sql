-- target: MIKKA_DATABASE_URL
-- BYOS metadata only. Refresh bundles and access projections stay in Infisical.
begin;
set local lock_timeout = '5s';
alter table byos_connections add column if not exists "accessSecretName" text;
alter table byos_connections add column if not exists "accessDigest" text;
alter table byos_connections add column if not exists "stagedAccessName" text;
alter table byos_connections add column if not exists "stagedAccessDigest" text;
create table if not exists byos_secret_artifacts (
  name text primary key,
  "connectionId" uuid not null references byos_connections(id) on delete cascade,
  "ownerId" text not null,
  "workspaceId" text not null,
  provider text not null check (provider in ('codex','claude')),
  kind text not null check (kind in ('grant','access','oauth')),
  "operationId" uuid,
  "notBefore" timestamptz not null,
  "publishedAt" timestamptz,
  "deletedAt" timestamptz,
  "deletingAt" timestamptz,
  "createStarted" boolean not null default false,
  "createSettled" boolean not null default false,
  "createUncertain" boolean not null default false,
  "lastError" text
);
create index if not exists byos_artifacts_cleanup_idx on byos_secret_artifacts ("connectionId", "notBefore") where "deletedAt" is null;
-- Preserve all known references, including recoverable uncertain publications.
insert into byos_secret_artifacts (name,"connectionId","ownerId","workspaceId",provider,kind,"notBefore","publishedAt","createStarted","createSettled")
select "secretName",id,"ownerId","workspaceId",provider,'grant',now(),now(),true,true from byos_connections where "secretName" is not null
on conflict do nothing;
insert into byos_secret_artifacts (name,"connectionId","ownerId","workspaceId",provider,kind,"operationId","notBefore","createStarted","createSettled")
select "stagedSecretName",id,"ownerId","workspaceId",provider,'grant',"operationId",coalesce("operationDeadline",now())+interval '30 seconds',true,false from byos_connections where "stagedSecretName" is not null
on conflict do nothing;
insert into byos_secret_artifacts (name,"connectionId","ownerId","workspaceId",provider,kind,"operationId","notBefore","createStarted","createSettled")
select a."secretName",c.id,c."ownerId",c."workspaceId",c.provider,'oauth',a."operationId",greatest(a."expiresAt",coalesce(c."operationDeadline",a."expiresAt"))+interval '30 seconds',true,true from byos_oauth_attempts a join byos_connections c on c.id=a."connectionId"
on conflict do nothing;
commit;
