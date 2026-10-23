-- target: MIKKA_DATABASE_URL
-- MIK-20: tables that existed before the tracked migration history.
-- scripts/migration-order.mjs deliberately runs ONLY this baseline before 0001.
-- All historical migrations remain byte-for-byte unchanged and still run.
-- Existing tables and rows are left untouched; indexes are created only together
-- with a missing table (no index build or data rewrite on populated tables).
-- Auth core matches Better Auth 1.7.12; OAuth tables are owned by 0009.
-- Workspace/project/team tables remain owned by DATABASE_URL's old migrations.

begin;
set local lock_timeout = '5s';

create table if not exists "user" (
  id text primary key,
  name text not null,
  email text not null unique,
  "emailVerified" boolean not null,
  image text,
  "createdAt" timestamptz not null,
  "updatedAt" timestamptz not null
);

do $$ begin
  if to_regclass('session') is null then
    create table "session" (
      id text primary key,
      "expiresAt" timestamptz not null,
      token text not null unique,
      "createdAt" timestamptz not null,
      "updatedAt" timestamptz not null,
      "ipAddress" text,
      "userAgent" text,
      "userId" text not null references "user" (id) on delete cascade
    );
    create index "session_userId_idx" on "session" ("userId");
  end if;
  if to_regclass('account') is null then
    create table account (
      id text primary key,
      "accountId" text not null,
      "providerId" text not null,
      "userId" text not null references "user" (id) on delete cascade,
      "accessToken" text,
      "refreshToken" text,
      "idToken" text,
      "accessTokenExpiresAt" timestamptz,
      "refreshTokenExpiresAt" timestamptz,
      scope text,
      password text,
      "createdAt" timestamptz not null,
      "updatedAt" timestamptz not null
    );
    create index "account_userId_idx" on account ("userId");
  end if;
  if to_regclass('verification') is null then
    create table verification (
      id text primary key,
      identifier text not null,
      value text not null,
      "expiresAt" timestamptz not null,
      "createdAt" timestamptz not null,
      "updatedAt" timestamptz not null
    );
    create index verification_identifier_idx on verification (identifier);
  end if;
end $$;

create table if not exists issues (
  id uuid primary key,
  "userId" text not null,
  title varchar(200) not null,
  content jsonb not null,
  status text not null,
  priority text not null,
  revision integer not null default 1,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create table if not exists issue_members (
  "issueId" uuid not null,
  "userId" text not null,
  "memberId" text not null,
  "createdAt" timestamptz not null default now(),
  primary key ("issueId", "memberId")
);

create table if not exists issue_documents (
  "issueId" uuid primary key,
  "userId" text not null,
  state text not null,
  "updatedAt" timestamptz not null default now()
);

create table if not exists issue_versions (
  id uuid primary key,
  "issueId" uuid not null,
  "userId" text not null,
  revision integer not null,
  title varchar(200) not null,
  content jsonb not null,
  status text not null,
  priority text not null,
  "createdAt" timestamptz not null default now()
);

do $$ begin
  if to_regclass('agent_sessions') is null then
    create table agent_sessions (
      id uuid primary key,
      "userId" text not null,
      title varchar(200) not null,
      "createdAt" timestamptz not null default now(),
      "updatedAt" timestamptz not null default now()
    );
    create index agent_sessions_user_updated_idx on agent_sessions ("userId", "updatedAt" desc);
  end if;
  if to_regclass('agent_turns') is null then
    create table agent_turns (
      id uuid primary key,
      "sessionId" uuid not null,
      "userId" text not null,
      prompt text not null,
      completion text not null default '',
      status text not null default 'pending',
      error text,
      "attemptId" uuid not null,
      "createdAt" timestamptz not null default now(),
      "updatedAt" timestamptz not null default now()
    );
    create index agent_turns_session_user_created_idx on agent_turns ("sessionId", "userId", "createdAt");
  end if;
end $$;

commit;
