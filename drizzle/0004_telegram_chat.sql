-- Telegram account pairing and durable conversation state, plus Chat SDK's
-- PostgreSQL adapter tables for webhook deduplication, locks, and queues.

create table if not exists telegram_links (
  "userId" text primary key references "user" (id) on delete cascade,
  "telegramUserId" text not null,
  "telegramUserName" text,
  "linkedAt" timestamptz not null default now()
);
create unique index if not exists telegram_links_telegram_user_key on telegram_links ("telegramUserId");

create table if not exists telegram_link_tokens (
  "userId" text primary key references "user" (id) on delete cascade,
  "tokenHash" text not null,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz not null default now()
);
create unique index if not exists telegram_link_tokens_hash_key on telegram_link_tokens ("tokenHash");

create table if not exists telegram_conversations (
  "threadId" text primary key,
  "userId" text not null references "user" (id) on delete cascade,
  "issueId" uuid references issues (id) on delete set null,
  "draftTitle" varchar(200),
  "draftDescription" text not null default '',
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create index if not exists telegram_conversations_user_idx on telegram_conversations ("userId");

create table if not exists chat_state_subscriptions (
  key_prefix text not null,
  thread_id text not null,
  created_at timestamptz not null default now(),
  primary key (key_prefix, thread_id)
);

create table if not exists chat_state_locks (
  key_prefix text not null,
  thread_id text not null,
  token text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (key_prefix, thread_id)
);
create index if not exists chat_state_locks_expires_idx on chat_state_locks (expires_at);

create table if not exists chat_state_cache (
  key_prefix text not null,
  cache_key text not null,
  value text not null,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (key_prefix, cache_key)
);
create index if not exists chat_state_cache_expires_idx on chat_state_cache (expires_at);

create table if not exists chat_state_lists (
  key_prefix text not null,
  list_key text not null,
  seq bigserial not null,
  value text not null,
  expires_at timestamptz,
  primary key (key_prefix, list_key, seq)
);
create index if not exists chat_state_lists_expires_idx on chat_state_lists (expires_at);

create table if not exists chat_state_queues (
  key_prefix text not null,
  thread_id text not null,
  seq bigserial not null,
  value text not null,
  expires_at timestamptz not null,
  primary key (key_prefix, thread_id, seq)
);
create index if not exists chat_state_queues_expires_idx on chat_state_queues (expires_at);
