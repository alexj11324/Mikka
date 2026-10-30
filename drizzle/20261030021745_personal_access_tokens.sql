-- target: MIKKA_DATABASE_URL
-- Settings › 个人访问令牌 (plan item 3). One person's API tokens in one
-- workspace. Only sha256(token) is stored; the plaintext is shown once at
-- creation and never again. "workspaceId" has no FK: workspaces live in the
-- workspace database (DATABASE_URL). Mirrors lib/db/token-schema.ts.
-- Revoked rows are kept (revokedAt) so a hash can never be reissued silently.
-- Rollback: DROP TABLE IF EXISTS personal_access_tokens;
create table if not exists personal_access_tokens (
  id uuid primary key,
  "userId" text not null references "user"(id) on delete cascade,
  "workspaceId" uuid not null,
  name text not null check (char_length(name) between 1 and 64),
  "tokenHash" text not null check ("tokenHash" ~ '^[a-f0-9]{64}$'),
  -- Last 4 characters of the token, so people can tell tokens apart.
  hint text not null check (hint ~ '^[A-Za-z0-9_-]{4}$'),
  "createdAt" timestamptz not null default now(),
  "expiresAt" timestamptz,
  "lastUsedAt" timestamptz,
  "revokedAt" timestamptz,
  constraint personal_access_tokens_expiry check ("expiresAt" is null or "expiresAt" > "createdAt")
);
create unique index if not exists personal_access_tokens_hash_key on personal_access_tokens ("tokenHash");
create index if not exists personal_access_tokens_owner_idx on personal_access_tokens ("userId", "workspaceId", "createdAt" desc) where "revokedAt" is null;
