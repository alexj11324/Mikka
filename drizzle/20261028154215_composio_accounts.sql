-- What Mikka keeps about each person's Composio connected accounts
-- (components/plugins/connected-apps.tsx): the provider email read once at
-- connect time (or once later for accounts connected earlier;
-- "emailCheckedAt" marks that it was asked, found or not), and which account
-- of a toolkit the bots use by default.
-- Tokens stay in Composio. At most one default per person and toolkit.
-- Additive and safe to re-run.
begin;
set local lock_timeout = '5s';

create table if not exists composio_accounts (
  "accountId" text primary key,
  "userId" text not null references "user"(id) on delete cascade,
  toolkit text not null,
  email text,
  "emailCheckedAt" timestamptz,
  "isDefault" boolean not null default false,
  "updatedAt" timestamptz not null default now()
);
alter table composio_accounts add column if not exists "emailCheckedAt" timestamptz;
create index if not exists composio_accounts_user_idx on composio_accounts ("userId", toolkit);
create unique index if not exists composio_accounts_default_key on composio_accounts ("userId", toolkit) where "isDefault";

commit;
