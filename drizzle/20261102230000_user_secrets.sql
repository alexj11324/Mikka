-- target: MIKKA_DATABASE_URL
-- Settings › 密钥与登录 › 我的: a person's own secrets (decision 2026-11-02-2120).
-- Account-level like user_e2b_keys: they follow the person into every workspace
-- and reach only that person's own runs. Values are AES-256-GCM ciphertext under
-- WORKSPACE_SECRETS_KEY; the AAD binds the row's user, kind and name.
-- Deleting the account deletes them (FK cascade). Mirrors lib/db/secrets-schema.ts.
-- Rollback: drop table user_secrets;
--           delete from schema_migrations where name = '20261102230000_user_secrets.sql';

create table if not exists user_secrets (
  id uuid primary key,
  "userId" text not null references "user"(id) on delete cascade,
  name text not null check (name ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'),
  kind text not null check (kind in ('secret', 'env')),
  note text not null default '' check (length(note) <= 500),
  ciphertext text not null,
  iv text not null,
  "keyVersion" integer not null,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  constraint user_secrets_name_key unique ("userId", name)
);
