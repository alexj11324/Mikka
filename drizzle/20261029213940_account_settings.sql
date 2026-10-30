-- Settings › 个人 › 账户 (docs/settings-backend/account.md): uploaded profile
-- pictures and emailed data-export links. Both belong to one person and go
-- with their account. Mirrors user_avatars and account_data_exports in
-- lib/db/schema.ts. Additive only; safe to run again.

create table if not exists user_avatars (
  "userId" text primary key references "user"(id) on delete cascade,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  "contentType" text not null check ("contentType" in ('image/png', 'image/jpeg', 'image/webp')),
  -- 200 KB: lib/account/avatar-file.ts AVATAR_MAX_BYTES.
  size integer not null check (size > 0 and size <= 204800),
  "storageKey" text,
  "inlineContent" bytea,
  "updatedAt" timestamptz not null default now(),
  constraint user_avatars_one_copy check (("storageKey" is null) <> ("inlineContent" is null))
);

create table if not exists account_data_exports (
  id uuid primary key,
  "userId" text not null references "user"(id) on delete cascade,
  -- sha256 of the emailed token; the token itself is never stored.
  "tokenHash" text not null,
  "createdAt" timestamptz not null default now(),
  "expiresAt" timestamptz not null,
  "downloadedAt" timestamptz
);
create unique index if not exists account_data_exports_token_key on account_data_exports ("tokenHash");
create index if not exists account_data_exports_user_created_idx on account_data_exports ("userId", "createdAt");
