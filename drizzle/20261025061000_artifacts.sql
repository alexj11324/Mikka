-- target: MIKKA_DATABASE_URL
-- Artifacts: documents and web pages agents hand over through the MCP tool
-- submit_artifact (lib/artifacts). Files live in R2; these tables keep the
-- versions and share links. Mirrors artifacts, artifactVersions and
-- artifactShares in lib/db/schema.ts. New tables only; IF NOT EXISTS makes a
-- retry safe. Applied by scripts/migrate.mjs on production builds.
set local lock_timeout = '5s';
select pg_advisory_xact_lock(hashtextextended(current_schema() || '.artifacts', 0));
create table if not exists artifacts (
  id uuid primary key,
  "userId" text not null,
  kind text not null check (kind in ('markdown', 'html')),
  title varchar(200) not null,
  "runId" uuid references agent_runs(id) on delete set null,
  "issueId" uuid references issues(id) on delete set null,
  "latestVersion" integer not null default 1 check ("latestVersion" > 0),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create index if not exists artifacts_user_idx on artifacts ("userId", "updatedAt");
create index if not exists artifacts_run_idx on artifacts ("runId");
create table if not exists artifact_versions (
  id uuid primary key,
  "artifactId" uuid not null references artifacts(id) on delete cascade,
  version integer not null check (version > 0),
  "storageKey" text not null,
  "inlineContent" text,
  sha256 text not null,
  size integer not null check (size >= 0),
  "authorName" text not null,
  "createdAt" timestamptz not null default now()
);
create unique index if not exists artifact_versions_version_key on artifact_versions ("artifactId", version);
create table if not exists artifact_shares (
  id uuid primary key,
  "artifactId" uuid not null references artifacts(id) on delete cascade,
  "tokenHash" text not null,
  "createdBy" text not null,
  "revokedAt" timestamptz,
  "createdAt" timestamptz not null default now()
);
create unique index if not exists artifact_shares_token_key on artifact_shares ("tokenHash");
create index if not exists artifact_shares_artifact_idx on artifact_shares ("artifactId");
